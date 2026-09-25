/* Sky dome — every plate-solved photo pinned to the celestial sphere.
 *
 * You are standing at the centre of the sphere looking out, which is where
 * the observer actually is. Drag to look around, scroll to zoom. Each photo
 * is drawn where its plate solve says it belongs, at the size and rotation
 * the solve gives it, so the picture on screen is a map of what the album
 * has actually covered rather than an arrangement of tiles.
 *
 * No dependencies and no external assets: raw WebGL, and the only imagery is
 * the photos themselves. The backdrop is a plain RA/Dec graticule — nothing
 * on screen is a stand-in for sky that was not photographed.
 *
 * Geometry. Each shot ships its WCS (crval / cd / crpix / image_size) rather
 * than pre-computed corners, so the client can subdivide the footprint into a
 * mesh and put every vertex through the real inverse gnomonic projection.
 * A flat quad would be within a pixel at this ~2x4 deg field, but the mesh
 * costs nothing and stays correct if a wide-field frame is ever added.
 *
 * Orientation. Vectors are x=cos(dec)cos(ra), y=cos(dec)sin(ra), z=sin(dec).
 * Viewed from the origin with +z up, east (+RA) falls to the LEFT — which is
 * how the sky looks facing south with north up, so the photos read the right
 * way round with no mirroring anywhere.
 *
 * The textures are built from the ORIGINAL photos, not the published JPGs:
 * publish.py rotates compare-slider pair members 90 deg CCW, which would put
 * the texture out of step with the WCS that describes it.
 *
 * Detail. Every frame ships as a ladder of resolutions (publish.py's
 * SKY_TIERS). Tier 0 is a few KB and every frame holds one for the whole
 * session, so the coverage map is complete the moment the dome opens; the
 * larger tiers are fetched only for the frames the viewer has actually
 * zoomed into, and dropped again once the view moves on. Zooming therefore
 * sharpens a frame instead of magnifying a thumbnail.
 */
(function () {
  "use strict";

  const DEG = Math.PI / 180;
  const SKY_DEG2 = 41252.96;      // area of the whole celestial sphere

  const FOV_MAX = 120;            // zoomed all the way out
  const FOV_MIN = 25 / 60;        // 25 arcminutes, zoomed all the way in
  const FOV_DEFAULT = 60;         // the field the dome opens at (cam.fov initial)
  /* Where the ARRIVAL flight stops. Not FOV_DEFAULT: flying all the way out to
   * 60° throws the subject away the moment you get there. The owner asked for
   * "about 4.0 degrees" — close enough that the frame you flew in on still
   * dominates the view, wide enough to show its neighbours around it. */
  const FOV_ARRIVE = 4.0;
  /* The field at the HAND-OFF, where the album's zoom and the dome's zoom meet.
   *
   * The goal is that the viewer cannot tell the transition happened, and the
   * limit on that is TEXTURE DETAIL, not geometry: pushed in to 25′ — or even
   * 50′ — the dome is magnifying its own texture past one texel per pixel, so a
   * sharp album photograph hands off to a soft dome and the softness is the tell.
   * 1.5° keeps the dome inside its detail budget while still being tight enough
   * that the frame dominates the view.
   *
   * gallery.js derives the album's zoom from this same constant, so the two
   * halves are at identical angular scale at the seam. They must stay tied. */
  const FOV_HANDOFF = 1.5;
  /* The field actually used at the last hand-off: the album's measured value when
   * it could supply one, otherwise FOV_HANDOFF. Entry and exit both read it, so
   * the return leg lands on the same scale it left from. */
  let handoffFov = FOV_HANDOFF;
  /* The flight frame's brightness pedestal (see uPedestal) and which shot it
   * applies to. Eased to 0 over the arrival zoom-out and back up over the exit
   * zoom-in, so both seams match the album and the wide view stays flattened. */
  let flightShotIdx = -1;
  let flightPedestal = 0;
  let flightPedestalFull = 0;
  /* How completely the flight frame OWNS the composite: 1 at the seam, 0 when
   * wide. The album shows one frame's pixels; the dome normally shows a
   * depth-weighted average of every stack covering a point, and on the Cygnus
   * Loop that is two to four of them. Averaging changes brightness (it diluted
   * the pedestal 4x) and sharpness, and both read as a jump at the seam. So
   * every OTHER frame's weight is scaled by (1 - flightBlend) — weights only
   * ever go down, so the 8-bit accumulation path cannot saturate — and the
   * normal blend returns over the zoom-out. */
  let flightBlend = 0;
  /* The seam renders at gain 1.0 whatever the slider says — that is the
   * setting at which a lone frame's pixels ARE the album's — and eases up to
   * the viewer's gain (GAIN_DEFAULT unless they moved the slider) as the seam
   * releases. 1 at the seam, 0 once released. */
  let flightGainHold = 0;
  function liveGain() {
    return flightGainHold > 0 ? Math.pow(domeGain, 1 - flightGainHold) : domeGain;
  }
  /* The field at which the pedestal and the single-frame dominance must both be
   * fully released: just inside the flight frame's own on-screen extent. Tied to
   * the FIELD, not to flight progress. Released over the whole zoom-out, the
   * neighbours were still half-suppressed when sky outside the frame came into
   * view, so they faded in as the field grew — the sky visibly assembling itself,
   * which is exactly the fly-in the owner asked never to see. Inside the frame
   * every pixel is the frame's own, so nothing is missing while they are held. */
  let flightReleaseFov = FOV_HANDOFF;
  function seamHold(fov) {
    const a = handoffFov, b = flightReleaseFov;
    if (!(b > a)) return 0;
    return Math.max(0, Math.min(1, (b - fov) / (b - a)));
  }
  /* Test-only: hold the arrival at the hand-off field for this long before the
   * zoom-out begins. Zero in normal use. It exists because the seam can only be
   * measured honestly with both sides at the SAME field — with a cached texture
   * the natural hold is instant, the zoom-out has already started by the time a
   * frame can be captured, and the comparison is contaminated by it. */
  let debugHoldMs = 0;
  /* The album's quarter turn, in degrees. Sign convention: positive roll turns
   * "up" toward "right" (see basis()). If the dome ever arrives 180° out from
   * the album, this is the sign to flip. */
  const ALBUM_QUARTER = 90;
  /* A live override for the arrival rotation, so the correct value can be found
   * by looking instead of by argument.
   *
   * The supervising agent cannot see the screen, and three passes of computing
   * this from the WCS have not matched what the owner sees. The geometry says the
   * axes line up; his eyes say they do not. Rather than guess a fourth time:
   *
   *     SkyDome.arrivalTurn(0)     // then re-fly and look
   *     SkyDome.arrivalTurn(90)
   *     SkyDome.arrivalTurn(180)
   *     SkyDome.arrivalTurn(270)
   *     SkyDome.arrivalTurn(null)  // back to the computed value
   *
   * Whichever lines up is the answer, and it takes seconds to find. */
  let turnOverride = null;
  let lastArrival = null;

  /* Graticule colour, now that the grid draws OVER the photographs rather
   * than being masked out behind them.
   *
   * The alpha had to come down. Against the cleared sky the old 0.55 was
   * reading against a near-black background; the same line laid over a star
   * field is competing with the picture, and a coordinate line that hides
   * the thing it is helping you find has the wrong priority. 0.34 stays
   * legible on empty sky — most of the dome is still empty — without
   * putting a lattice across a nebula.
   *
   * The three named circles keep their own hues and get a milder haircut:
   * they are the ones you actually navigate by, and there are only three. */
  const GRID_RGBA = [0.30, 0.38, 0.52, 0.34];
  const GRID_OVER_ALPHA = 0.72;

  /* A backdrop is context, not a photograph on equal footing, and it is
   * shown at a fraction of the gain the real frames get. Held back rather
   * than dimmed to nothing: the point of putting the Milky Way behind the
   * album is to show that the deep frames sit INSIDE something. */
  const BG_GAIN = 0.62;
  /* Where the sharpest texture on offer reaches one screen pixel per texture
   * pixel. Not a limit — the dome zooms past it, to FOV_MIN — but it is the
   * point past which the picture stops gaining and the pixels only get
   * bigger, so the zoom bar marks it rather than pretending it isn't there. */
  let fovSharp = 0;

  /* Overlap transparency. Where footprints intersect, each contributing
   * frame is drawn at 1/N so the intersection is the average of all of
   * them and every one shows through. N is counted per PIXEL, in the
   * fragment shader, by projecting the pixel's sky direction through the
   * WCS of each frame this one overlaps — so the transparent region is the
   * exact Boolean intersection of the footprints, with hard edges, rather
   * than a soft approximation interpolated across the mesh.
   *
   * Slots for the neighbours of one frame. The album's busiest frame has
   * eight and the most-covered point on the sky has nine photos over it;
   * ten leaves room to grow before the cap starts dropping neighbours. */
  const OVERLAP_SLOTS = 10;
  let ovlSlots = 0;               // what the GPU's uniform budget allows
  /* Decoded detail textures are big — 2560x1440 is ~15 MB of video memory —
   * so they live on a budget and the least-recently-viewed are dropped back
   * to their tier-0 texture, which is never released. */
  /* Detail-texture budget. A `let` because a capture temporarily raises it:
   * a capture needs every one of its frames sharp AT THE SAME TIME, and the
   * browsing budget is sized for what is on screen. Restored afterwards. */
  /* 160 MB was sized for a ladder that stopped at 2048, where a texture is
   * 1024x2048x4 = 8.4 MB and nineteen frames fit at once. The ladder now goes
   * to native sampling, and the arithmetic changes completely:
   *
   *     2048 tier   1024 x 2048 x 4 =    8.4 MB    19 frames fit
   *     4096 tier   2048 x 4096 x 4 =   33.6 MB     4 frames fit
   *     8192 tier   4096 x 8192 x 4 =  134.2 MB     ONE frame, 84% of budget
   *
   * Zoomed into a mosaic, two neighbouring frames each wanting their top tier
   * could not coexist, so they evicted each other on every refine: the plates
   * flickered and "sharpening..." never cleared, because something was always
   * in flight. That was not a loading problem, it was thrashing.
   *
   * 512 MB holds fifteen frames at 4096 or three at 8192, which covers what is
   * actually on screen at any zoom, and is a modest ask of a desktop GPU. */
  let DETAIL_BUDGET = 512 * 1024 * 1024;
  const DETAIL_BUDGET_BROWSE = 512 * 1024 * 1024;
  const DETAIL_BUDGET_CAPTURE_MAX = 1024 * 1024 * 1024;
  const MAX_INFLIGHT = 3;         // concurrent detail fetches
  const SETTLE_MS = 140;          // quiet time before asking for sharper tiles

  let gl = null, canvas = null, overlay = null;
  let prog = null, gridProg = null, fullProg = null;
  let accFB = null, accTex = null, accW = 0, accH = 0, fullBuf = null;
  let accHalf = false, extHalf = null, extHalfRT = null;
  /* Coverage is divided down by this before accumulating, so an 8-bit
   * target can hold several overlaps without clamping. It cancels
   * exactly in the composite — (sum c*v/K) / (sum v/K) — so it costs
   * colour precision and nothing else. Only used when half float is
   * unavailable. */
  const ACC_SCALE = 8.0;

  /* Overlap weighting by integration depth.
   *
   * Two frames covering the same sky are averaged by coverage, which is
   * right when they are comparable — it hides the seam and averages down
   * the noise — and wrong when one is far deeper: a 39.7 min Lagoon stack
   * and a 12.5 min Trifid stack sit at almost the same centre and the dome
   * drew half of each, so the deep one was reported as simply not there.
   *
   * REF is the reference integration (the album's p75, 10 min), so a frame
   * at the reference weighs 1 before normalising and the curve is readable
   * without knowing the distribution — which is skewed: median 2.7 min,
   * max 103.
   *
   * POW is 1, which makes the weight proportional to integration time. That
   * is not a taste setting: it is what stacking itself does. For
   * background-limited data the optimal combination is inverse-variance
   * weighted, variance goes as 1/t, so the weight goes as t — and the
   * result carries the signal of everything that overlaps rather than
   * whichever frame is deepest. It was 1.5 for a while, chosen to make a
   * deep frame WIN its overlap after one read as absent; that overcorrected.
   * Winning is not the goal, combining is. At 1 the Lagoon's 39.7 min and
   * the Trifid's 12.5 contribute 76% and 24% — exactly their share of the
   * photons — instead of 85/15.
   *
   * A frame with no depth recorded weighs as if it were at the reference,
   * never zero. Weights only matter WHERE FRAMES OVERLAP — the composite
   * divides by accumulated coverage, so a frame alone on its patch of sky
   * is drawn at full strength whatever its weight. */
  const DEPTH_REF_S = 600;
  const DEPTH_POW = 1.0;
  const DEPTH_CLAMP = 8;

  /* Effective integration: shutter time times what actually got through.
   *
   * The weight above is proportional to integration time because variance
   * goes as 1/t. That reasoning is sound and it assumes every second is
   * worth the same, which is false. Measured over this album, exposure and
   * delivered depth correlate at only +0.45: M 8's 39.7-minute stack, taken
   * low in the south through the thickest air we shoot, reaches 154
   * stars/deg^2 where a 3.5-minute NGC 6712 frame reaches 1199. On time
   * alone M 8 wins that overlap 11:1 while being the shallower frame.
   *
   * `q` is the frame's measured completeness against the album's own
   * cross-matched star set, restricted to sky more than one frame covers —
   * so field richness cancels and it is a fair comparison of the frames that
   * are actually competing. See publish._unique_stars.
   *
   * Multiplying rather than replacing is deliberate, because each alone
   * fails a different way. Time alone cannot see haze. Completeness alone
   * saturates: two frames that both find everything score 1.0, and averaging
   * a 100-minute and a 20-minute frame equally throws away real signal. The
   * product keeps the inverse-variance ordering between frames of equal
   * transparency and penalises only the ones that did not deliver. A frame
   * with no measurement keeps its integration time unchanged, never zero. */
  /* A single Seestar exposure covers about 2.20 x 3.91 deg. Anything on the
   * dome substantially wider than that is a MOSAIC, and its integration time
   * is the total across every tile — not what any one point on it received. */
  const FRAME_REF_DEG2 = 2.20 * 3.91;

  function frameAreaDeg2(s) {
    if (s._areaDeg2 != null) return s._areaDeg2;
    const cd = s.wcs.cd, [iw, ih] = s.wcs.image_size;
    const det = Math.abs(cd[0][0] * cd[1][1] - cd[0][1] * cd[1][0]);
    s._areaDeg2 = det * iw * ih;
    return s._areaDeg2;
  }

  function effectiveIntegration(s) {
    let t = (typeof s.integrationS === "number" && s.integrationS > 0)
      ? s.integrationS : DEPTH_REF_S;
    const q = s.q;   // measured stars/deg^2 on contested sky, album median 1.0

    /* Integration has to be PER UNIT SKY, not per file.
     *
     * The Sagittarius mosaic reports 1190 s, and that is honest — it is what
     * the shutter was open for, and it is what the card should print. But it
     * was spread over ten tiles across 34 deg^2, so any given point on it
     * received roughly a quarter of that. Weighting by the total let a wide
     * survey mosaic outrank a dedicated deep frame of the very object inside
     * it: measured here, M 8's own Lagoon frame came to 7.5 effective minutes
     * against the mosaic's 9.0, so the mosaic would have taken the Lagoon.
     *
     * Scaling by area needs no mosaic flag and no tile count — a mosaic is
     * simply a frame several times the size of one exposure. Clamped at 1 so
     * a CROPPED frame (our stacks are 1960x3640 against the Seestar's
     * 2160x3840) is never inflated by the same rule. */
    /* Integration has to be PER UNIT SKY. The Sagittarius mosaic reports
     * 1190 s honestly — that is what the shutter was open for, and what the
     * card should print — but it was spread over ten tiles across 34 deg^2,
     * so any one point received about a quarter of it. Clamped at 1 so a
     * CROPPED frame (our stacks are 1960x3640 against the Seestar's
     * 2160x3840) is never inflated by the same rule.
     *
     * This applies only on the FALLBACK path below. Where a frame carries a
     * measurement, that measurement is already per square degree and
     * correcting for area as well would count the same thing twice. */
    const area = frameAreaDeg2(s);
    const perPoint = area > FRAME_REF_DEG2
      ? t * (FRAME_REF_DEG2 / area) : t;

    if (!(typeof q === "number" && q > 0)) return perPoint;

    /* Measured richness LEADS; exposure only breaks ties.
     *
     * `q` is how many distinct stars this frame delivers per square degree of
     * the sky it SHARES with others, relative to the album median. It is a
     * density, not a completeness fraction — an earlier version used the
     * fraction and it read wrong, because normalising by the sky's own
     * richness removes the thing the eye is reacting to. M 20 scored 0.75
     * against M 24's 0.85 while showing 645 stars/deg^2 against 1962, so a
     * thin frame held its own against a star cloud three times richer. Where
     * a dozen footprints overlap, averaging them all washes out the faint
     * stars only the best ones caught, and that is what paints a rectangle
     * of flat sky with straight edges over a rich field.
     *
     * The exponent is not a taste setting. Star counts go roughly as
     * 10^(0.6 m), so a density ratio is a limiting-magnitude difference of
     * log10(q)/0.6, and one magnitude on background-limited data costs
     * 10^0.8 in exposure — so the exposure a frame is WORTH goes as
     * q^(0.8/0.6) = q^(4/3). Exposure is already an input to what was
     * measured, so it does not appear again except as a quarter-power
     * tie-break between frames of equal richness, where the longer one is
     * still the better one. */
    const tie = Math.pow(perPoint / DEPTH_REF_S, 0.25);
    return DEPTH_REF_S * Math.pow(q, 4 / 3) * tie;
  }

  function depthWeight(integrationS, half) {
    const t = (typeof integrationS === "number" && integrationS > 0)
      ? integrationS : DEPTH_REF_S;
    const raw = Math.pow(t / DEPTH_REF_S, DEPTH_POW);
    const w = Math.min(Math.max(raw, 1 / DEPTH_CLAMP), DEPTH_CLAMP) / DEPTH_CLAMP;
    // The 8-bit fallback target cannot hold 1/64 of a unit — it would round
    // a lone shallow frame away entirely. Give that path a shallower curve
    // rather than a wrong picture; it is already the degraded route.
    return half ? w : Math.max(w, 1 / DEPTH_CLAMP);
  }
  let shots = [], meta = null;
  let gridBuf = null, gridCount = 0;
  let raf = 0, ready = false, opened = false;
  let detailBytes = 0, inflight = 0, useStamp = 0, refineTimer = 0;
  let bestPxPerDeg = 0;           // finest sampling any frame can offer
  let aniso = null, anisoMax = 1;

  // Camera: a look direction plus a vertical field of view. Pitch is clamped
  // just short of the poles so the up-vector never degenerates. `roll` is a
  // rotation about the view axis (0 = the pole of the current alignment is
  // up); the N↔S control and the flight drive it.
  const cam = { yaw: 0, pitch: 0, fov: FOV_DEFAULT, roll: 0 };
  let hovered = -1;
  let hoveredObj = null;
  // How many frames the cursor is inside, so the HUD can say when the
  // one you are being offered is not the only one there.
  let hoveredStack = 0;
  let eqCount = 0;

  /* Camera basis: forward, right, up. Shared by the projection matrix and
   * by ray-picking so the two can never drift apart — when they disagree,
   * the frame you click is not the frame under the cursor. */
  function basis() {
    const cp = Math.cos(cam.pitch);
    const f = [cp * Math.cos(cam.yaw), cp * Math.sin(cam.yaw), Math.sin(cam.pitch)];
    let r = [f[1], -f[0], 0];
    const rl = Math.hypot(r[0], r[1]) || 1;
    r = [r[0] / rl, r[1] / rl, 0];
    let u = [
      r[1] * f[2] - r[2] * f[1],
      r[2] * f[0] - r[0] * f[2],
      r[0] * f[1] - r[1] * f[0],
    ];
    // Roll about the view axis: rotate the right/up pair in their own plane.
    // Positive roll turns "up" toward "right" — on screen, north leans east.
    if (cam.roll) {
      const cr = Math.cos(cam.roll), sr = Math.sin(cam.roll);
      const rr = [r[0] * cr - u[0] * sr, r[1] * cr - u[1] * sr, r[2] * cr - u[2] * sr];
      const uu = [r[0] * sr + u[0] * cr, r[1] * sr + u[1] * cr, r[2] * sr + u[2] * cr];
      r = rr; u = uu;
    }
    return { f, r, u };
  }

  /* PURE — rotate a vector about a unit axis (Rodrigues). No DOM. */
  function rotVec(v, axis, ang) {
    const c = Math.cos(ang), s = Math.sin(ang);
    const d = axis[0] * v[0] + axis[1] * v[1] + axis[2] * v[2];
    return [
      v[0] * c + (axis[1] * v[2] - axis[2] * v[1]) * s + axis[0] * d * (1 - c),
      v[1] * c + (axis[2] * v[0] - axis[0] * v[2]) * s + axis[1] * d * (1 - c),
      v[2] * c + (axis[0] * v[1] - axis[1] * v[0]) * s + axis[2] * d * (1 - c),
    ];
  }

  /* PURE — one drag step, in the ROLLED screen basis. A screen-space drag of
   * (dx, dy) pixels rotates the view about the screen's own right/up axes by
   * dx*perPx / dy*perPx radians, then yaw/pitch/roll are read back out. This
   * is what removes the pole singularity: no cos(pitch) division, and a
   * sideways drag stays sideways however the view is rolled. Radians in and
   * out; pitch is clamped to ±89.5°. */
  function dragStep(yaw, pitch, roll, dx, dy, perPx) {
    const cp = Math.cos(pitch);
    const f = [cp * Math.cos(yaw), cp * Math.sin(yaw), Math.sin(pitch)];
    let r0 = [f[1], -f[0], 0];
    const rl = Math.hypot(r0[0], r0[1]) || 1;
    r0 = [r0[0] / rl, r0[1] / rl, 0];
    const u0 = [
      r0[1] * f[2] - r0[2] * f[1],
      r0[2] * f[0] - r0[0] * f[2],
      r0[0] * f[1] - r0[1] * f[0],
    ];
    const cr = Math.cos(roll), sr = Math.sin(roll);
    const r = [r0[0] * cr - u0[0] * sr, r0[1] * cr - u0[1] * sr, r0[2] * cr - u0[2] * sr];
    const u = [r0[0] * sr + u0[0] * cr, r0[1] * sr + u0[1] * cr, r0[2] * sr + u0[2] * cr];
    // Drag: rotate about screen-right (r) by dy*perPx, then about the new
    // screen-up by dx*perPx.
    const f1 = rotVec(f, r, dy * perPx);
    const u1 = rotVec(u, r, dy * perPx);
    const f2 = rotVec(f1, u1, dx * perPx);
    const u2 = u1;
    const pitch2 = Math.max(-89.5 * DEG, Math.min(89.5 * DEG,
      Math.asin(Math.max(-1, Math.min(1, f2[2])))));
    const yaw2 = Math.atan2(f2[1], f2[0]);
    // Roll read back: the angle of u2 in the roll-0 right/up plane at the
    // new yaw/pitch.
    const rr = [Math.sin(yaw2), -Math.cos(yaw2), 0];
    const cp2 = Math.cos(pitch2);
    const ff = [cp2 * Math.cos(yaw2), cp2 * Math.sin(yaw2), Math.sin(pitch2)];
    const uu = [
      rr[1] * ff[2] - rr[2] * ff[1],
      rr[2] * ff[0] - rr[0] * ff[2],
      rr[0] * ff[1] - rr[1] * ff[0],
    ];
    const roll2 = Math.atan2(u2[0] * rr[0] + u2[1] * rr[1] + u2[2] * rr[2],
                              u2[0] * uu[0] + u2[1] * uu[1] + u2[2] * uu[2]);
    return { yaw: yaw2, pitch: pitch2, roll: roll2 };
  }

  /* Height of the drawing surface in device pixels — the number that
   * decides both how sharp a texture needs to be and how far in it is
   * worth zooming. Falls back to the CSS box before the first paint sets
   * canvas.height. */
  function surfaceH() {
    if (canvas && canvas.height) return canvas.height;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    return Math.round(((canvas && canvas.clientHeight) || 900) * dpr);
  }

  function fovMin() { return FOV_MIN; }

  function clampFov(f) {
    return Math.max(FOV_MIN, Math.min(FOV_MAX, f));
  }

  /* PURE — the flight's FOV at eased time k in [0,1]: starts at exactly
   * FOV_HANDOFF (50′) and eases geometrically out to FOV_ARRIVE (4°). The
   * geometric ramp is the same shape flyTo uses (halving the field is the
   * same visual step anywhere on the scale). No DOM. */
  function flightFov(k) { return flightFovFrom(FOV_HANDOFF, k); }
  /* Same geometric ramp, but from a measured starting field. The album reports
   * the degrees-per-pixel it is ACTUALLY rendering at the hand-off, and the dome
   * starts there — so the two match by construction rather than by agreeing on a
   * constant. */
  function flightFovFrom(from, k) {
    const t = Math.max(0, Math.min(1, k));
    const f0 = (isFinite(from) && from > 0) ? from : FOV_HANDOFF;
    return f0 * Math.pow(FOV_ARRIVE / f0, t);
  }

  /* PURE — the sky-space unit vector along a shot's image +y axis.
   *
   * Needed to arrive in the dome with the photograph at the SAME rotation the
   * album showed it at, instead of snapping to celestial north. wcsHandoff
   * gives the position angle of +y east of north; this turns that angle back
   * into a direction at the shot's own centre, which rollToPole can then be
   * asked to put "up". No DOM. */
  function shotUpDir(w) {
    /* "Up" is the direction the picture's TOP ROW lies in from its centre —
     * taken from the solve itself by projecting the centre and a point
     * straight above it, then keeping the component tangent to the sphere at
     * the centre. Not from the position angle: the CD matrix's angle is the
     * one at the TANGENT POINT (crval), and a compare-slider member is warped
     * onto its partner's frame, so its centre sits up to a tenth of a degree
     * from crval. Meridians converge — at NGC 654's dec 62 that tenth of a
     * degree turned the arrival 0.1 deg off the album (1.3 px at the seam);
     * following the pixel axis itself is exact for any frame. */
    const W = w.image_size[0], H = w.image_size[1];
    const [ra, dec] = pixToSky(W / 2, H / 2, w);
    const [raU, decU] = pixToSky(W / 2, H / 2 - Math.max(8, H / 8), w);
    const c = vec(ra, dec), u = vec(raU, decU);
    const d = c[0] * u[0] + c[1] * u[1] + c[2] * u[2];
    const v = [u[0] - d * c[0], u[1] - d * c[1], u[2] - d * c[2]];
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
  }

  /* PURE — the camera roll that puts a shot's +y axis "up" on screen, plus an
   * optional extra turn for the quarter-rotation the album applies to portrait
   * sources (gallery.js rotates the stage 90° when naturalHeight > naturalWidth,
   * so the dome has to match that or the hand-off visibly twists). */
  function rollForShot(w, extraTurnDeg) {
    const h = wcsHandoff(w);
    const yaw = h.raDeg * DEG;
    const pitch = Math.max(-89.5 * DEG, Math.min(89.5 * DEG, h.decDeg * DEG));
    return rollToPole(shotUpDir(w), yaw, pitch) + (extraTurnDeg || 0) * DEG;
  }

  /* The field at which the sharpest texture available is 1:1 with the
   * screen. Recomputed on resize because it depends on how many device
   * pixels the canvas actually has. */
  function updateSharpFov() {
    fovSharp = bestPxPerDeg > 0
      ? Math.max(FOV_MIN, Math.min(FOV_MAX, surfaceH() / bestPxPerDeg))
      : 0;
  }

  /* Re-point the camera so `dir` lands under the given screen point.
   *
   * Solved in closed form rather than nudged towards the answer: with
   * r = (sinY, -cosY, 0), u = (-sinP cosY, -sinP sinY, cosP) and f the look
   * direction, a ray whose camera-space components are (a, b, c) has
   *   dir.z = b cosP + c sinP
   * which gives the pitch outright, and the two horizontal components then
   * give the yaw as a single atan2. Iterating instead would leave the point
   * under the cursor creeping during a long zoom. */
  function aimAt(dir, clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = 1 - ((clientY - rect.top) / rect.height) * 2;
    const t = Math.tan(cam.fov * DEG / 2);
    const aspect = rect.width / rect.height;
    /* The cursor's offset in the ROLLED screen basis, expressed in the unrolled
     * one the solve below assumes. This used to ignore cam.roll: dirAt() (which
     * supplied `dir`) honours the roll, so the target was right, but the re-aim
     * treated the offset as if the view were upright. With a large roll — and
     * the Image alignment always has one — each wheel notch pulled the view off
     * along a rolled direction: the owner's "weird movements when zooming out".
     * basis() rolls r' = r*cr - u*sr, u' = r*sr + u*cr, so an offset a'r' + b'u'
     * is (a'cr + b'sr) r + (-a'sr + b'cr) u. */
    const ap = ndcX * t * aspect, bp = ndcY * t;
    const cr = Math.cos(cam.roll || 0), sr = Math.sin(cam.roll || 0);
    let a = ap * cr + bp * sr, b = -ap * sr + bp * cr, c = 1;
    const n = Math.hypot(a, b, c) || 1;
    a /= n; b /= n; c /= n;
    const amp = Math.hypot(b, c);
    if (amp < 1e-9) return;
    let P = Math.asin(Math.max(-1, Math.min(1, dir[2] / amp)))
          - Math.atan2(b, c);
    P = Math.max(-89.5 * DEG, Math.min(89.5 * DEG, P));
    const K = c * Math.cos(P) - b * Math.sin(P);
    cam.pitch = P;
    cam.yaw = Math.atan2(a * dir[0] + K * dir[1], K * dir[0] - a * dir[1]);
  }

  /* Zoom about a screen point instead of about the middle of the view.
   * At 8 degrees centre-zoom was tolerable; at half a degree the thing you
   * were aiming at slides off screen before you arrive, so the point under
   * the cursor is pinned across the change. */
  function zoomAt(factor, clientX, clientY) {
    cancelFlight();
    const next = clampFov(cam.fov * factor);
    if (next === cam.fov) return;
    const dir = dirAt(clientX, clientY);
    cam.fov = next;
    aimAt(dir, clientX, clientY);
    schedule(); updateHud(); refineSoon();
  }

  // ── Spherical helpers ─────────────────────────────────────────────
  function vec(raRad, decRad) {
    const cd = Math.cos(decRad);
    return [cd * Math.cos(raRad), cd * Math.sin(raRad), Math.sin(decRad)];
  }

  /* Inverse gnomonic (TAN): image pixel -> RA/Dec in radians.
   * py is measured from the TOP of the image; FITS y counts from the
   * bottom, which is the flip gallery.js also applies in wcsProject().
   *
   * PIXEL CONVENTION. px/py are continuous image coordinates with the origin
   * at the top-left CORNER (a texel's centre sits at +0.5, the image spans
   * 0..W). CRPIX is FITS: 1-based, and a whole number names a pixel CENTRE, so
   * the centre of a 2160-wide frame is 1080.5. The two differ by half a pixel
   * on each axis, and leaving that out placed every frame half a pixel off
   * along its own axes — invisible on one frame, but between two frames turned
   * 180 deg to each other it is 1.4 px (5 arcsec on a Seestar), which is where
   * stars "slide" when overlapping stacks are blended. gallery.js's wcsProject
   * and publish.py's file_frame_solve apply the same half pixel. */
  function pixToSky(px, py, w) {
    const dx = px + 0.5 - w.crpix[0];
    const dy = (w.image_size[1] - py + 0.5) - w.crpix[1];
    let xiDeg = w.cd[0][0] * dx + w.cd[0][1] * dy;
    let etaDeg = w.cd[1][0] * dx + w.cd[1][1] * dy;
    // Field curvature the linear WCS cannot express. A mosaic is nine tangent
    // planes stitched together and no single one fits it: measured against the
    // album's own overlaps, M 24's error grows from 8 arcsec at the centre to
    // 15 at 3 degrees out, while Sadr's stays flat. `dist` is a per-frame
    // second-order term fitted from those overlaps by
    // tools/fit_dome_distortion.py, present only on frames it measurably
    // helped. It has NO constant or linear part by construction, so it can
    // only bend the plate — the solve still decides where the frame is, how it
    // is turned and how big it is. Applied here, at the mesh vertices, so the
    // texture is never resampled.
    if (w.dist) {
      // Distortion the linear WCS cannot express. A mosaic is nine tangent
      // planes stitched together and no single one fits it: measured against
      // ASTAP's own star catalogue, V1331 Aquilae's error runs 10.7 arcsec
      // beyond 0.45 of its half-diagonal while its centre is fine. A quadratic
      // fixes the middle and leaves the edges — third order takes that 10.7 to
      // 0.79 — which is why this is the same shape a SIP solution uses.
      //
      // Fitted by tools/fit_dome_distortion.py against the catalogue, not
      // against neighbouring frames, and present only on frames it measurably
      // helped. Applied here, at the mesh vertices, so no texture is resampled.
      //
      // Term order must match poly_terms() in that tool exactly:
      //   for i in 0..order: for j in 0..order-i: u^i * v^j
      // `order: 0` means the first term only, i.e. a plain shift.
      const u = px / w.image_size[0] - 0.5;
      const v = py / w.image_size[1] - 0.5;
      const cx = w.dist.c_xi, ce = w.dist.c_eta;
      const order = w.dist.order | 0;
      let k = 0, up = 1;
      for (let i = 0; i <= order; i++) {
        let vp = 1;
        for (let j = 0; j <= order - i; j++) {
          const t = up * vp;
          xiDeg += cx[k] * t;
          etaDeg += ce[k] * t;
          k++;
          vp *= v;
        }
        up *= u;
      }
    }
    const xi = xiDeg * DEG;
    const eta = etaDeg * DEG;
    const ra0 = w.crval[0] * DEG, dec0 = w.crval[1] * DEG;
    const rho = Math.hypot(xi, eta);
    if (rho < 1e-12) return [ra0, dec0];
    const c = Math.atan(rho), sc = Math.sin(c), cc = Math.cos(c);
    const dec = Math.asin(cc * Math.sin(dec0) + eta * sc * Math.cos(dec0) / rho);
    const ra = ra0 + Math.atan2(xi * sc,
      rho * Math.cos(dec0) * cc - eta * Math.sin(dec0) * sc);
    return [ra, dec];
  }

  /* Forward TAN: RA/Dec (radians) -> image pixel, or null if behind the
   * tangent point. Used for hit-testing a look direction against a frame. */
  function skyToPix(ra, dec, w) {
    const ra0 = w.crval[0] * DEG, dec0 = w.crval[1] * DEG;
    const cosC = Math.sin(dec0) * Math.sin(dec)
      + Math.cos(dec0) * Math.cos(dec) * Math.cos(ra - ra0);
    if (cosC <= 0) return null;
    const xi = Math.cos(dec) * Math.sin(ra - ra0) / cosC / DEG;
    const eta = (Math.cos(dec0) * Math.sin(dec)
      - Math.sin(dec0) * Math.cos(dec) * Math.cos(ra - ra0)) / cosC / DEG;
    const cd = w.cd;
    const det = cd[0][0] * cd[1][1] - cd[0][1] * cd[1][0];
    if (Math.abs(det) < 1e-12) return null;
    const dx = (cd[1][1] * xi - cd[0][1] * eta) / det;
    const dy = (-cd[1][0] * xi + cd[0][0] * eta) / det;
    // FITS pixel centres -> continuous corner-origin coordinates (see pixToSky)
    return [w.crpix[0] + dx - 0.5, w.image_size[1] - (w.crpix[1] + dy) + 0.5];
  }

  // ── Hand-off maths (pure, no WebGL, no DOM) ────────────────────────
  /* The numbers that make the album's flat photograph and the dome's
   * perspective camera show the SAME sky at the hand-off. All derived from
   * the shot's own WCS, so the two renderers cannot disagree about the sky
   * they are showing.
   *
   *   raDeg / decDeg  sky under the image centre (the dome's yaw/pitch)
   *   fovDeg          image angular HEIGHT in degrees (the dome's vertical
   *                   field, since the dome's fov is vertical)
   *   widthDeg        image angular width in degrees
   *   paDeg           position angle of the image's +y axis, east of north —
   *                   the raw stack's rotation on the sky, and the angle the
   *                   dome must roll by to put the stack's own "up" at the
   *                   top of the screen
   *   scaleArcsecPx   pixel scale, matching ASTAP's scale_arcsec_per_pixel
   */
  function wcsHandoff(w) {
    const W = w.image_size[0], H = w.image_size[1];
    const det = w.cd[0][0] * w.cd[1][1] - w.cd[0][1] * w.cd[1][0];
    const scale = Math.sqrt(Math.abs(det));            // deg per pixel
    const [raC, decC] = pixToSky(W / 2, H / 2, w);
    /* cd column 2 (dxi/dy, deta/dy) is the image +y direction, and its position
     * angle east of north is atan2 of those two — with NO cos(dec) factor.
     *
     * There was one here, on the reasoning that the east component is
     * dRA*cos(dec). That is true of a raw RA difference, but CD does not produce
     * one: it maps pixels straight to the intermediate world coordinates xi/eta,
     * which are already degrees on the tangent plane, with the cos(dec) folded in.
     * Applying it twice sheared the frame. Measured over all 201 shots: with the
     * factor the image's x and y axes came out 9.234 deg from square (worst
     * 88.5); without it they are square to 0.022 deg (worst 0.65). The resulting
     * position-angle error averaged 4.98 deg and reached 50 deg at dec 85
     * (NGC188), which is why the dome arrived visibly rotated off true. */
    const paDeg = Math.atan2(w.cd[0][1], w.cd[1][1]) / DEG;
    return {
      raDeg: raC / DEG, decDeg: decC / DEG,
      fovDeg: H * scale, widthDeg: W * scale,
      paDeg, scaleArcsecPx: scale * 3600,
    };
  }

  /* Round-trip residual of the WCS pair the dome is built on: project each
   * corner through pixToSky then back through skyToPix and measure how far
   * it lands from where it started, in pixels. The mesh and the hit-test use
   * these two as exact inverses, so the seamlessness of a hand-off is bounded
   * by this number. */
  function wcsRoundTripPx(w) {
    const W = w.image_size[0], H = w.image_size[1];
    let worst = 0;
    for (const [px, py] of [[0, 0], [W, 0], [0, H], [W, H], [W / 2, H / 2]]) {
      const sky = pixToSky(px, py, w);
      const back = skyToPix(sky[0], sky[1], w);
      if (!back) return null;
      const e = Math.hypot(back[0] - px, back[1] - py);
      if (e > worst) worst = e;
    }
    return worst;
  }

  /* The roll that puts a chosen pole "up" at the current view. `pole` is a
   * unit vector (e.g. celestial north = [0,0,1]); `yaw`/`pitch` are the
   * camera's look direction. Returns radians. Earth's pole is up at roll 0
   * by construction of basis(), so aligning to Earth returns 0. */
  function rollToPole(pole, yaw, pitch) {
    const cp = Math.cos(pitch);
    const f = [cp * Math.cos(yaw), cp * Math.sin(yaw), Math.sin(pitch)];
    let r = [f[1], -f[0], 0];
    const rl = Math.hypot(r[0], r[1]) || 1;
    r = [r[0] / rl, r[1] / rl, 0];
    const u = [
      r[1] * f[2] - r[2] * f[1],
      r[2] * f[0] - r[0] * f[2],
      r[0] * f[1] - r[1] * f[0],
    ];
    // Project the pole into the tangent plane; the roll that turns current
    // "up" toward that direction.
    const pf = pole[0] * f[0] + pole[1] * f[1] + pole[2] * f[2];
    let t = [pole[0] - pf * f[0], pole[1] - pf * f[1], pole[2] - pf * f[2]];
    const tl = Math.hypot(t[0], t[1], t[2]);
    if (tl < 1e-9) return 0;                 // looking straight at the pole
    t = [t[0] / tl, t[1] / tl, t[2] / tl];
    const dot = u[0] * t[0] + u[1] * t[1] + u[2] * t[2];
    // cross(u,t) is along f; its f-component gives the signed angle.
    return Math.atan2(
      (u[1] * t[2] - u[2] * t[1]) * f[0]
      + (u[2] * t[0] - u[0] * t[2]) * f[1]
      + (u[0] * t[1] - u[1] * t[0]) * f[2],
      dot,
    );
  }

  // ── GL plumbing ───────────────────────────────────────────────────
  function compile(src, type) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      throw new Error("shader: " + gl.getShaderInfoLog(s));
    }
    return s;
  }

  function link(vsrc, fsrc) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(vsrc, gl.VERTEX_SHADER));
    gl.attachShader(p, compile(fsrc, gl.FRAGMENT_SHADER));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error("link: " + gl.getProgramInfoLog(p));
    }
    return p;
  }


  /* The accumulation target the footprints are averaged in. Sized to the
   * canvas and rebuilt when that changes; no depth attachment because the
   * footprint pass does not depth-test. */
  function ensureAccum(W, H) {
    if (accFB && accW === W && accH === H) return true;
    if (accTex) gl.deleteTexture(accTex);
    if (accFB) gl.deleteFramebuffer(accFB);
    // The target holds SUMS: colour x coverage, and coverage. Coverage
    // reaches 2, 3, 4 wherever frames overlap, so an UNSIGNED_BYTE target
    // is wrong — it clamps at 1.0, the divisor saturates, and overlaps come
    // out summed instead of averaged. That showed up immediately as bright
    // hard-edged panes over Cygnus (+41% mean sky) the first time this was
    // rendered. Half float where the driver allows it; the 1/ACC_SCALE
    // fallback below keeps 8-bit workable by making room for several
    // overlaps before it clamps.
    accHalf = false;
    if (extHalf && extHalfRT) {
      accTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, accTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, W, H, 0, gl.RGBA,
                    extHalf.HALF_FLOAT_OES, null);
      accHalf = true;
    } else {
      accTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, accTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, W, H, 0, gl.RGBA,
                    gl.UNSIGNED_BYTE, null);
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    accFB = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, accFB);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0,
                            gl.TEXTURE_2D, accTex, 0);
    let ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    if (!ok && accHalf) {
      // Driver advertised half float but will not render to it. Retry 8-bit.
      gl.bindTexture(gl.TEXTURE_2D, accTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, W, H, 0, gl.RGBA,
                    gl.UNSIGNED_BYTE, null);
      accHalf = false;
      ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    accW = W; accH = H;
    if (!ok) { accFB = null; }      // caller falls back to direct drawing
    return ok;
  }

  /* uSpin carries the opening flight and is the identity for all but the
   * three seconds after the dome opens (see "Opening flight"). It rotates
   * the frame from wherever it started to where it belongs.
   *
   * Applied to the POSITION only: vUV comes from the attribute, so the
   * photograph travels and turns with its own geometry, and the two
   * fragment shaders decide coverage from the texture rather than from a
   * direction — so nothing downstream needs to know the frame has moved.
   *
   * A rotation and nothing else, so a frame in flight is still exactly on
   * the sphere at its true size, and — once it is the identity — the map
   * is exactly right rather than nearly. */
  const VS_TEX = `
    attribute vec3 aPos; attribute vec2 aUV;
    uniform mat4 uVP; uniform mat3 uSpin;
    varying vec2 vUV; varying vec3 vDir;
    void main() {
      vUV = aUV; vDir = aPos;
      gl_Position = uVP * vec4(uSpin * aPos, 1.0);
    }`;

  /* Fragment shader for the footprints.
   *
   * It used to take an array of neighbour projection matrices (uOvl) and
   * count, per pixel, how many other FOOTPRINTS covered it — then divide by
   * that count so overlaps averaged. Clever, and wrong for any frame with
   * unimaged area: an unfinished mosaic covers its neighbours geometrically
   * while contributing no light, so everything under its empty region was
   * divided by 2, 3, 4 and went dark. That is the "black areas mask other
   * images" fault reported on the live dome.
   *
   * Now each frame writes (colour x coverage, coverage) into an RGBA target
   * and compositeDome divides once. Same average where frames genuinely
   * overlap, no weight at all where a frame holds nothing — and no uniform
   * budget, so the slot cap and its "a thin sliver stays opaque" caveat are
   * both gone. `slots` is still accepted so callers need not change. */
  function fsTex(slots) {
    // One number used twice: GLSL ES 1.00 requires a constant loop bound,
    // so the slot count is baked into the source in both places rather
    // than read from a uniform. Named slotCount, not n: the shader body
    // has its own float n for the coverage count, and ${n} sitting beside
    // it would read as the same thing.
    const slotCount = Math.max(slots, 1);
    return `
    #ifdef GL_FRAGMENT_PRECISION_HIGH
      precision highp float;
    #else
      precision mediump float;
    #endif
    uniform sampler2D uTex;
    uniform float uHasTex;
    uniform float uAccScale;   // 1.0 for a half-float target, 1/K for 8-bit
    uniform vec2 uTexel;       // 1/texture size, for the erosion tap
    uniform float uWeight;     // this frame's share of an overlap (see below)
    /* The sky level publish.py subtracted from THIS frame's texture, added back
     * for the flight so the hand-off matches the album's picture. 0 for every
     * other frame and once the flight has zoomed away — the flattening exists
     * so tiles blend on the sphere, and this must not undo it at wide fields. */
    uniform float uPedestal;
    uniform float uFeather;    // 0 on the dome; texels of edge ramp on a capture
    varying vec2 vUV;
    varying vec3 vDir;

    /* Does this frame actually hold light here?
     *
     * publish.py forces unimaged area to EXACT black after flattening
     * ("so the dome still draws nothing where nothing was photographed"),
     * while real sky is lifted to the sky target near 0.05. A small
     * threshold separates the two cleanly. A frame whose texture has not
     * loaded yet counts as covered, so the map stays complete while it
     * fills in. */
    float lit(vec2 uv) {
      vec3 c = texture2D(uTex, uv).rgb;
      return step(0.012, max(c.r, max(c.g, c.b)));
    }

    /* Valid AND clear of the edge.
     *
     * Testing the single texel puts the cut exactly on the boundary of the
     * unimaged area, which is where a JPEG's ringing and the texture's own
     * bilinear filtering both live — so the seam keeps a rim of half-dark
     * pixels. Requiring the neighbourhood to be lit as well erodes the mask
     * by the tap radius and moves the cut off that boundary. ERODE is in
     * texels of the tier currently bound, so it scales with the texture
     * rather than with the zoom. */
    float dataAt(vec3 c, float hasTex) {
      if (hasTex < 0.5) return 1.0;
      const float E = 2.5;                 // erosion radius, texels
      vec2 d = uTexel * E;
      float v = step(0.012, max(c.r, max(c.g, c.b)));
      v *= lit(vUV + vec2( d.x, 0.0)) * lit(vUV + vec2(-d.x, 0.0));
      v *= lit(vUV + vec2(0.0,  d.y)) * lit(vUV + vec2(0.0, -d.y));
      v *= lit(vUV + d) * lit(vUV - d);
      v *= lit(vUV + vec2(d.x, -d.y)) * lit(vUV + vec2(-d.x, d.y));
      return v;
    }

    /* Soften the frame's own rectangular border.
     *
     * Coverage is otherwise a step: 1 inside the plate, 0 outside. Where
     * two frames of different sky background meet, that step is a visible
     * hard seam, which is the thing a custom capture stitched from several
     * frames would be judged on. Ramping coverage to zero over the last
     * few texels makes the weighted average cross-fade between the frames
     * instead of cutting, and costs nothing on the dome, where uFeather
     * is 0 and this returns 1.
     *
     * Analytic, not sampled: the distance to a UV edge is known exactly,
     * so there is no ring of extra taps and no banding. It handles the
     * plate BORDER; unimaged interior (a mosaic's empty tiles) is still
     * the eroded data test above, which is the right treatment for a
     * boundary whose shape is not known ahead of time. */
    float edgeFade() {
      if (uFeather <= 0.0) return 1.0;
      // In UV, not texels. Texels made the ramp depend on which TIER the
      // frame happens to be showing — the same edge faded over 5% of the
      // plate at tier 0 and 0.7% at tier 2, so a seam softened as you zoomed
      // in and hardened as you zoomed out. UV is the frame itself.
      vec2 fromEdge = min(vUV, vec2(1.0) - vUV);
      float d = min(fromEdge.x, fromEdge.y);
      // Smoothstep rather than a linear ramp: a linear one has a corner
      // where it reaches full weight, and that corner is itself a faint
      // line — which is the thing being removed.
      float k = clamp(d / uFeather, 0.0, 1.0);
      return k * k * (3.0 - 2.0 * k);
    }
    void main() {
      // Before its texture arrives a frame still shows, as a faint plate —
      // so the coverage map is complete from the first paint instead of
      // filling in raggedly as images load.
      vec3 c = uHasTex > 0.5 ? texture2D(uTex, vUV).rgb : vec3(0.16, 0.20, 0.28);
      float v = dataAt(c, uHasTex);
      // Colour AND coverage, accumulated together into an RGBA target and
      // divided once at the end (compositeDome). The divisor used to be a
      // count of overlapping FOOTPRINTS. That is
      // wrong for any frame with unimaged area: an unfinished mosaic covers
      // its neighbours geometrically while contributing no light, so every
      // frame under it was drawn at 1/N and the region went dark. Measured
      // on the Sadr mosaic — 21.3% of its frame is unimaged, spread over
      // 4.39 x 7.80 deg, with nine solved frames inside it including
      // IC 1318B. Weighting by data instead of by rectangle fixes that, and
      // needs no uniform budget, so the slot cap and its "a thin sliver
      // stays opaque" caveat are gone with it.
      // Weighted by integration depth, so an overlap resolves in favour of
      // the better frame instead of averaging to a mush. Coverage-only
      // weighting made a 39.7 min Lagoon stack and a 12.5 min Trifid stack
      // at the same centre contribute half each, and the deep one was
      // reported as simply not on the dome. uWeight is (EFFECTIVE
      // integration seconds)^DEPTH_POW normalised, so near-equal frames still
      // blend — which is what hides their seam — and a clear winner takes the
      // field. Effective, not raw: shutter time times measured completeness,
      // because exposure and delivered depth correlate at only +0.45 here.
      // See effectiveIntegration().
      v *= edgeFade();
      gl_FragColor = vec4((c + vec3(uPedestal * uHasTex)) * v, v) * (uAccScale * uWeight);
    }`;
  }


  /* Composite. The footprints accumulate into an RGBA target as
   * (colour x coverage, coverage); this divides once, which is the average
   * over however many frames actually held light there. Alpha 0 where
   * nothing did, so the graticule shows through instead of black. */
  const VS_FULL = `
    attribute vec2 aXY; varying vec2 vT;
    void main() { vT = aXY * 0.5 + 0.5; gl_Position = vec4(aXY, 0.0, 1.0); }`;
  const FS_FULL = `
    precision mediump float;
    uniform sampler2D uAcc;
    uniform float uGain;       // viewer's brightness slider; 1.0 = as measured
    varying vec2 vT;
    void main() {
      vec4 a = texture2D(uAcc, vT);
      // Coverage can legitimately be as small as one shallow frame's weight
      // (1/64) on the half-float path, so this only rejects true zero.
      if (a.a <= 1e-6) discard;
      // Gain rides here rather than as a CSS filter on the canvas, because
      // this pass resolves the PHOTOGRAPHS only. The graticule, the reference
      // rings and the markers are drawn by other programs, so they keep their
      // designed contrast while the sky brightens under them.
      gl_FragColor = vec4(a.rgb / a.a * uGain, 1.0);
    }`;

  const VS_LINE = `
    attribute vec3 aPos; uniform mat4 uVP; varying float vZ;
    void main() { gl_Position = uVP * vec4(aPos, 1.0); vZ = 1.0; }`;

  const FS_LINE = `
    precision mediump float; uniform vec4 uColor;
    void main() { gl_FragColor = uColor; }`;

  // ── Matrices ──────────────────────────────────────────────────────
  function viewProj(aspect) {
    const { f, r, u } = basis();
    // View matrix (camera at origin, so no translation column).
    const V = [
      r[0], u[0], -f[0], 0,
      r[1], u[1], -f[1], 0,
      r[2], u[2], -f[2], 0,
      0, 0, 0, 1,
    ];
    const t = 1 / Math.tan(cam.fov * DEG / 2);
    const near = 0.01, far = 10;
    const P = [
      t / aspect, 0, 0, 0,
      0, t, 0, 0,
      0, 0, (far + near) / (near - far), -1,
      0, 0, 2 * far * near / (near - far), 0,
    ];
    // P * V, column-major.
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) {
      for (let rI = 0; rI < 4; rI++) {
        let s = 0;
        for (let k = 0; k < 4; k++) s += P[k * 4 + rI] * V[c * 4 + k];
        o[c * 4 + rI] = s;
      }
    }
    return o;
  }

  // ── Geometry build ────────────────────────────────────────────────
  /* MESH x MESH quads per footprint. Four was plenty while the dome
   * bottomed out at 8 degrees — the gnomonic warp across a 2x4 degree field
   * is well under a pixel there. At half a degree the screen resolves about
   * 3000 pixels per degree and a coarse mesh shows as a frame that does not
   * quite line up with its neighbour across an overlap, so the subdivision
   * follows the zoom range down. 169 vertices a frame is nothing. */
  const MESH = 12;

  function buildShot(s, order) {
    const w = s.wcs;
    const [iw, ih] = w.image_size;
    // The album revisits targets, so ~13.5% of the footprint area is
    // overlap. Two frames on the same sphere of radius 1 are exactly
    // coplanar there and z-fight into a shimmering mess. Nudging each to
    // its own radius separates them in depth WITHOUT moving any of them on
    // the sky — a radial shift changes distance only, never direction, so
    // the astrometry is untouched. Lower index = smaller radius = nearer
    // the observer = drawn on top, and pick() resolves ties the same way.
    // Every footprint sits strictly inside the graticule's radius of 1, so
    // the depth prepass always puts photographs in front of coordinate
    // lines. Within that, one radius each: on a single sphere the frames
    // that overlap are exactly coplanar and z-fight, and a radial shift
    // separates them in depth without moving any of them on the sky.
    // Lower index = smaller radius = nearer = picked first by pick().
    const R = 0.998 - order * 2e-4;
    const pos = [], uv = [], idx = [];
    // The mesh vertices double as a sample of directions across the
    // footprint, which is what the overlap search tests against.
    s.samples = [];
    for (let j = 0; j <= MESH; j++) {
      for (let i = 0; i <= MESH; i++) {
        const px = (i / MESH) * iw, py = (j / MESH) * ih;
        const [ra, dec] = pixToSky(px, py, w);
        const v = vec(ra, dec);
        pos.push(v[0] * R, v[1] * R, v[2] * R);
        uv.push(i / MESH, j / MESH);
        s.samples.push(v);
      }
    }
    const row = MESH + 1;
    for (let j = 0; j < MESH; j++) {
      for (let i = 0; i < MESH; i++) {
        const a = j * row + i, b = a + 1, c = a + row, d = c + 1;
        idx.push(a, b, c, b, d, c);
      }
    }
    s.pos = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, s.pos);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(pos), gl.STATIC_DRAW);
    s.uv = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, s.uv);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(uv), gl.STATIC_DRAW);
    s.idxBuf = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, s.idxBuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(idx), gl.STATIC_DRAW);
    s.count = idx.length;
    // Centre direction, for sorting and for "fly to this frame".
    const cRa = w.crval[0] * DEG, cDec = w.crval[1] * DEG;
    s.centre = vec(cRa, cDec);
    // The four plate corners as sky directions. A custom capture needs to
    // know which frames actually fall inside the region a viewer drew, and
    // the centre-and-radius test it filters with is a circle around a
    // rectangle — generous enough to claim frames that only come near.
    s.corners = [[0, 0], [iw, 0], [iw, ih], [0, ih]].map(([px, py]) => {
      const [ra, dec] = pixToSky(px, py, w);
      return vec(ra, dec);
    });
    s.ra = cRa; s.dec = cDec;
    // Angular extent, from the CD matrix — degrees of sky per image pixel
    // along each axis. `degLong` is what a texture's pixels are spread over,
    // so it converts a tier's size into a sampling rate; `radius` is the
    // half-diagonal, used to tell whether the frame is on screen at all.
    const sx = Math.hypot(w.cd[0][0], w.cd[1][0]);
    const sy = Math.hypot(w.cd[0][1], w.cd[1][1]);
    s.degLong = Math.max(iw * sx, ih * sy) || 1;
    s.radius = 0.5 * Math.hypot(iw * sx, ih * sy) * DEG;
    s.proj = projMatrix(w);
  }

  /* The 3x3 that carries a sky direction to homogeneous image coordinates
   * for one frame: (a, b, c) with u = a/c, v = b/c normalised over the
   * image, and c <= 0 meaning the direction is behind the tangent point.
   *
   * It is the forward TAN of skyToPix() rewritten without trigonometry.
   * xi and eta are dot products of the direction with the east and north
   * unit vectors at the tangent point, over the dot product with the
   * tangent point itself; everything after that — the inverse CD matrix,
   * the crpix shift, the FITS y-flip, the divide by image size — is linear,
   * so the whole chain collapses into three rows. That is what lets the
   * fragment shader run this test for ten frames per pixel. */
  function projMatrix(w) {
    const ra0 = w.crval[0] * DEG, dec0 = w.crval[1] * DEG;
    const [iw, ih] = w.image_size;
    const p0 = vec(ra0, dec0);
    const eRa = [-Math.sin(ra0), Math.cos(ra0), 0];
    const eDec = [-Math.sin(dec0) * Math.cos(ra0),
                  -Math.sin(dec0) * Math.sin(ra0), Math.cos(dec0)];
    const cd = w.cd;
    const det = cd[0][0] * cd[1][1] - cd[0][1] * cd[1][0];
    if (!isFinite(det) || Math.abs(det) < 1e-12) return null;
    const k = 1 / (det * DEG);
    const rowA = [], rowB = [];
    for (let i = 0; i < 3; i++) {
      // u = [(crpix0 - 0.5) * (p0.d) + (cd11*(eRa.d) - cd01*(eDec.d))/(det*DEG)] / iw
      // — the half pixel is skyToPix's FITS-centre -> corner-origin step.
      rowA[i] = ((w.crpix[0] - 0.5) * p0[i]
                 + k * (cd[1][1] * eRa[i] - cd[0][1] * eDec[i])) / iw;
      // v flips: py = ih - (crpix1 + dy) + 0.5, so the dy term changes sign.
      rowB[i] = ((ih - w.crpix[1] + 0.5) * p0[i]
                 - k * (-cd[1][0] * eRa[i] + cd[0][0] * eDec[i])) / ih;
    }
    // Column-major, as uniformMatrix3fv expects with transpose = false.
    return new Float32Array([
      rowA[0], rowB[0], p0[0],
      rowA[1], rowB[1], p0[1],
      rowA[2], rowB[2], p0[2],
    ]);
  }

  /* Is this direction inside that frame's footprint? Same test the shader
   * runs, on the CPU, so the overlap search and the rendering can never
   * disagree about what counts as an intersection. */
  function insideProj(d, s) {
    const m = s.proj;
    if (!m) return false;
    const c = m[2] * d[0] + m[5] * d[1] + m[8] * d[2];
    if (c <= 0) return false;
    const u = (m[0] * d[0] + m[3] * d[1] + m[6] * d[2]) / c;
    if (u < 0 || u > 1) return false;
    const v = (m[1] * d[0] + m[4] * d[1] + m[7] * d[2]) / c;
    return v >= 0 && v <= 1;
  }

  /* Which frames overlap which. Circumscribed circles reject almost every
   * pair for free; survivors are checked by asking whether any of one
   * frame's mesh directions lands inside the other. An overlap thinner
   * than the mesh spacing can be missed, and when it is, a sliver a few
   * pixels wide stays opaque instead of going half-transparent — the
   * failure mode is invisible, which is the right way for this to be
   * wrong. */
  let overlapsBuilt = false;

  /* Build the graph on demand, once. Callers ask through ensureOverlaps();
   * nothing calls buildOverlaps() directly except this. */
  function ensureOverlaps() {
    if (overlapsBuilt) return;
    overlapsBuilt = true;
    const capped = buildOverlaps();
    if (capped) {
      console.warn(`SkyDome: ${capped} overlap(s) past the ${ovlSlots}-slot ` +
        `budget were dropped; those intersections are weighted slightly high.`);
    }
  }

  function buildOverlaps() {
    for (const s of shots) s.nbrs = [];
    if (ovlSlots <= 0) return 0;
    let capped = 0;
    for (let i = 0; i < shots.length; i++) {
      const a = shots[i];
      for (let j = i + 1; j < shots.length; j++) {
        const b = shots[j];
        const dot = a.centre[0] * b.centre[0] + a.centre[1] * b.centre[1]
                  + a.centre[2] * b.centre[2];
        const reach = a.radius + b.radius;
        if (reach < Math.PI && dot < Math.cos(reach)) continue;
        if (a.samples.some((d) => insideProj(d, b))
            || b.samples.some((d) => insideProj(d, a))) {
          a.nbrs.push(j); b.nbrs.push(i);
        }
      }
    }
    for (const s of shots) {
      if (s.nbrs.length <= ovlSlots) continue;
      // Over budget: keep the closest, which are the biggest overlaps.
      // Dropping one leaves that intersection slightly mis-weighted, so
      // it is counted and reported rather than absorbed.
      s.nbrs.sort((x, y) => {
        const dx = shots[x].centre[0] * s.centre[0] + shots[x].centre[1] * s.centre[1] + shots[x].centre[2] * s.centre[2];
        const dy = shots[y].centre[0] * s.centre[0] + shots[y].centre[1] * s.centre[1] + shots[y].centre[2] * s.centre[2];
        return dy - dx;
      });
      capped += s.nbrs.length - ovlSlots;
      s.nbrs.length = ovlSlots;
    }
    // AND DROPPED ON BOTH SIDES. Each frame trimmed its own list against
    // its own distances, so a busy frame could forget a neighbour that
    // still remembered it. That is the one case the shader cannot survive:
    // the intersection is divided by 2 where one frame draws it and by 1
    // where the other does, so it comes out brighter than either
    // photograph — a seam along the edge of a frame, which is the artefact
    // the whole divide-once composite exists to avoid.
    //
    // Dropping the other half costs the same coverage either way and keeps
    // the two sides agreeing. The pair is still counted in `capped` and
    // still reported: that intersection is now weighted 1/1 by both, which
    // is slightly bright, but slightly bright ON BOTH SIDES leaves no edge.
    //
    // Both sides are tested against the SAME snapshot, so the result is
    // exactly the set of edges that survived in both directions — not
    // whatever order the loop happened to run in.
    const held = shots.map((s) => new Set(s.nbrs));
    for (let i = 0; i < shots.length; i++) {
      shots[i].nbrs = shots[i].nbrs.filter((j) => held[j].has(i));
    }
    // Pack each frame's neighbour matrices into one contiguous array,
    // zero-filled past the last one so unused slots never match.
    for (const s of shots) {
      s.ovl = new Float32Array(9 * Math.max(ovlSlots, 1));
      s.nbrs.forEach((j, k) => {
        const m = shots[j].proj;
        if (m) s.ovl.set(m, k * 9);
      });
    }
    return capped;
  }

  /* A great circle defined by its pole. Every great circle on the sphere
   * is the set of directions perpendicular to some axis, so one function
   * covers the celestial equator, the ecliptic and the galactic plane —
   * only the pole changes. Returns interleaved line-segment vertices. */
  function greatCircle(pole, stepDeg) {
    // Any vector not parallel to the pole gives a starting point on the
    // circle; two cross products turn it into an orthonormal frame.
    const seed = Math.abs(pole[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    let a = [
      pole[1] * seed[2] - pole[2] * seed[1],
      pole[2] * seed[0] - pole[0] * seed[2],
      pole[0] * seed[1] - pole[1] * seed[0],
    ];
    const n = Math.hypot(a[0], a[1], a[2]) || 1;
    a = [a[0] / n, a[1] / n, a[2] / n];
    const b = [
      pole[1] * a[2] - pole[2] * a[1],
      pole[2] * a[0] - pole[0] * a[2],
      pole[0] * a[1] - pole[1] * a[0],
    ];
    const at = (t) => [
      a[0] * Math.cos(t) + b[0] * Math.sin(t),
      a[1] * Math.cos(t) + b[1] * Math.sin(t),
      a[2] * Math.cos(t) + b[2] * Math.sin(t),
    ];
    const out = [];
    for (let d = 0; d < 360; d += stepDeg) {
      const p1 = at(d * DEG), p2 = at((d + stepDeg) * DEG);
      out.push(p1[0], p1[1], p1[2], p2[0], p2[1], p2[2]);
    }
    return out;
  }

  /* The three reference circles, each drawn in its own pass so each can
   * have its own colour. Poles are J2000.
   *
   *   equator   Earth's own spin axis, projected outwards — the +z axis,
   *             because the whole coordinate system is built on it.
   *   ecliptic  the plane Earth orbits in, so the Sun's path across the
   *             year; its pole is the celestial pole tilted by the 23.44
   *             degree obliquity.
   *   galactic  the plane of the Milky Way. Its pole is a measured
   *             direction, RA 12h 51.4m Dec +27.13, not a derived one. */
  const CIRCLES = [
    { key: "equator",  pole: [0, 0, 1],           colour: [0.45, 0.60, 0.85, 0.85] },
    { key: "ecliptic", pole: null, obliquity: 23.4392911,
      colour: [0.95, 0.78, 0.35, 0.75] },
    { key: "galactic", pole: null, ra: 192.85948, dec: 27.12825,
      colour: [0.55, 0.85, 0.72, 0.70] },
  ];

  /* Places worth knowing about, whether or not there is a photograph there.
   *
   * The dome is a map of what the telescope has recorded, which makes it very
   * good at showing where the frames are and silent about where anything IS.
   * A ring costs nothing, points at sky nobody has imaged as readily as sky
   * everybody has, and turns "somewhere in Sagittarius" into a thing you can
   * aim at on a later night.
   *
   * Rings rather than filled dots: the point is to say WHERE, and a disc
   * would cover the very sky it is pointing at.
   *
   * Four kinds, coloured apart:
   *   galaxy     the structure of the Milky Way — its centre, the direction
   *              straight out the other side, and the two poles you look
   *              through to see out of the disc entirely
   *   grid       where the coordinate systems themselves are pinned
   *   target     bright things this album has never pointed at, checked
   *              against its own coverage rather than chosen from a list
   *   odd        directions that are interesting for a reason other than
   *              what is in them
   *
   * Positions are J2000. Antipodes are computed rather than typed, so the
   * anticentre cannot drift from the centre.
   */
  const SGR_A = { ra: 266.41684, dec: -29.00781 };
  const NGP = { ra: 192.85948, dec: 27.12825 };
  const anti = (o) => ({ ra: (o.ra + 180) % 360, dec: -o.dec });

  const MARKER_KIND = {
    galaxy: [0.35, 0.95, 0.55, 0.95],   // green
    grid:   [0.55, 0.72, 1.00, 0.80],   // blue
    target: [1.00, 0.78, 0.35, 0.90],   // amber
    odd:    [0.95, 0.55, 0.95, 0.85],   // magenta
  };

  const MARKERS = [
    // — the Milky Way itself —
    { ...SGR_A, kind: "galaxy", label: "Galactic centre · Sgr A*" },
    { ...anti(SGR_A), kind: "galaxy", label: "Galactic anticentre" },
    { ...NGP, kind: "galaxy", label: "North galactic pole" },
    { ...anti(NGP), kind: "galaxy", label: "South galactic pole" },
    // — where the coordinates are pinned —
    { ra: 0, dec: 90, kind: "grid", label: "North celestial pole" },
    { ra: 0, dec: 0, kind: "grid", label: "Vernal equinox · 0h" },
    { ra: 270, dec: 66.5607, kind: "grid", label: "North ecliptic pole" },
    // — bright, and not in this album —
    { ra: 23.4621, dec: 30.6602, kind: "target", label: "M 33 Triangulum" },
    { ra: 279.0997, dec: -23.9047, kind: "target", label: "M 22" },
    { ra: 11.888, dec: -25.288, kind: "target", label: "NGC 253 Sculptor" },
    { ra: 83.8221, dec: -5.3911, kind: "target", label: "M 42 Orion" },
    { ra: 56.75, dec: 24.1167, kind: "target", label: "M 45 Pleiades" },
    { ra: 97.98, dec: 4.95, kind: "target", label: "Rosette" },
    { ra: 16.8, dec: 60.72, kind: "target", label: "Heart & Soul" },
    // — interesting for other reasons —
    { ra: 277.0, dec: 30.0, kind: "odd", label: "Solar apex" },
    { ra: 187.7059, dec: 12.3911, kind: "odd", label: "Virgo cluster · M 87" },
    { ra: 290.667, dec: 44.5, kind: "odd", label: "Kepler field" },
  ];

  const MARKER_SEGMENTS = 40;
  const MARKER_SCREEN_FRAC = 0.026;   // ring radius as a fraction of the field
  let markersOn = true;
  let markerBuf = null;
  let markerLayer = null;

  /* ── Brightness ────────────────────────────────────────────────────
   * A viewing gain on the resolved photographs, not a change to the data.
   *
   * It earns its place because the dome shows frames of wildly different
   * depth side by side: a 40-minute stack and a 3-minute one are both drawn
   * at their measured brightness, which is honest and which also means the
   * shallow ones sit close to black on a bright screen. This lets a viewer
   * lift them without touching what was measured — the numbers on every card,
   * and any capture taken from the dome, are unchanged.
   *
   * Guarded storage for the same reason gallery.js guards it: a browser set
   * to block site data THROWS on the property access, and an unguarded read
   * at module scope would take the whole dome down with it. */
  const GAIN_KEY = "astrogallery.dome.gain";
  /* 1.5 by the owner's eye: the dome's textures are sky-flattened and read
   * darker than the raw stacks at 1.0. The flight seam is exempt — it renders
   * at an effective 1.0 (plus the pedestal) so the hand-off stays exact, and the
   * gain eases up to this default as the dome zooms away. */
  const GAIN_MIN = 0.4, GAIN_MAX = 4.0, GAIN_DEFAULT = 1.5;
  function domeLsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function domeLsSet(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }
  function clampGain(v) {
    return Math.min(GAIN_MAX, Math.max(GAIN_MIN, Number(v) || GAIN_DEFAULT));
  }
  let domeGain = (function () {
    const raw = domeLsGet(GAIN_KEY);
    return raw == null ? GAIN_DEFAULT : clampGain(parseFloat(raw));
  })();

  /* A small circle on the sphere: the centre swung out by `radius` in every
   * direction around itself, using any two axes perpendicular to it. */
  function smallCircle(centre, radius, segments, into, at) {
    let t1 = cross3(centre, [0, 0, 1]);
    if (Math.hypot(t1[0], t1[1], t1[2]) < 1e-6) t1 = cross3(centre, [1, 0, 0]);
    t1 = norm3(t1);
    const t2 = norm3(cross3(centre, t1));
    const cr = Math.cos(radius), sr = Math.sin(radius);
    const pt = (i) => {
      const a = (i % segments) / segments * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      return [
        centre[0] * cr + (t1[0] * ca + t2[0] * sa) * sr,
        centre[1] * cr + (t1[1] * ca + t2[1] * sa) * sr,
        centre[2] * cr + (t1[2] * ca + t2[2] * sa) * sr,
      ];
    };
    for (let i = 0; i < segments; i++) {
      const a = norm3(pt(i)), b = norm3(pt(i + 1));
      into.set(a, at + i * 6);
      into.set(b, at + i * 6 + 3);
    }
    return at + segments * 6;
  }

  function markerDir(m) { return vec(m.ra * DEG, m.dec * DEG); }

  /* Drawn AFTER the photographs and with the depth test off. Several of these
   * sit in the most heavily imaged sky in the album, and a marker the
   * pictures cover is no marker. */
  function drawMarkers(VP) {
    if (!markersOn || !gridProg) return;
    const radius = Math.max(0.02 * DEG, cam.fov * DEG * MARKER_SCREEN_FRAC);
    const perRing = MARKER_SEGMENTS * 6;
    if (!markerBuf) markerBuf = gl.createBuffer();
    gl.useProgram(gridProg);
    gl.uniformMatrix4fv(gl.getUniformLocation(gridProg, "uVP"), false, VP);
    const pos = gl.getAttribLocation(gridProg, "aPos");
    const col = gl.getUniformLocation(gridProg, "uColor");
    gl.enableVertexAttribArray(pos);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    // One buffer per kind, so the colour changes once rather than per ring.
    for (const kind of Object.keys(MARKER_KIND)) {
      const list = activeMarkers().filter((m) => m.kind === kind);
      if (!list.length) continue;
      const verts = new Float32Array(list.length * perRing);
      let at = 0;
      for (const m of list) {
        at = smallCircle(markerDir(m), radius, MARKER_SEGMENTS, verts, at);
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, markerBuf);
      gl.bufferData(gl.ARRAY_BUFFER, verts, gl.DYNAMIC_DRAW);
      gl.vertexAttribPointer(pos, 3, gl.FLOAT, false, 0, 0);
      const c = MARKER_KIND[kind];
      gl.uniform4f(col, c[0], c[1], c[2], c[3]);
      gl.drawArrays(gl.LINES, 0, verts.length / 3);
    }
    gl.disable(gl.BLEND);
    gl.enable(gl.DEPTH_TEST);
  }

  /* Labels, as DOM over the canvas. A ring with no name is a mystery, and
   * the whole point of these is to say what you are looking at. Only the
   * ones actually on screen get an element, so a full sky costs nothing. */
  function updateMarkerLabels() {
    if (!markerLayer) return;
    if (!markersOn) { markerLayer.style.display = "none"; return; }
    markerLayer.style.display = "";
    const rect = canvas.getBoundingClientRect();
    const radiusPx = rect.height * MARKER_SCREEN_FRAC;
    let n = 0;
    for (const m of activeMarkers()) {
      const q = screenAt(markerDir(m));
      let el = m._el;
      const on = q && q[0] > rect.left - 80 && q[0] < rect.right + 80
                   && q[1] > rect.top - 40 && q[1] < rect.bottom + 40;
      if (!on) { if (el) el.style.display = "none"; continue; }
      if (!el) {
        el = document.createElement("span");
        el.className = "dome-marker-label is-" + m.kind;
        el.textContent = m.label;
        markerLayer.appendChild(el);
        m._el = el;
      }
      el.style.display = "";
      el.style.left = `${(q[0] - rect.left).toFixed(0)}px`;
      el.style.top = `${(q[1] - rect.top + radiusPx + 4).toFixed(0)}px`;
      n++;
    }
    return n;
  }

  function setMarkers(on) {
    markersOn = !!on;
    const btn = document.getElementById("dome-markers-toggle");
    if (btn) {
      btn.classList.toggle("is-on", markersOn);
      btn.setAttribute("aria-pressed", markersOn ? "true" : "false");
    }
    updateMarkerLabels();
    schedule();
    return markersOn;
  }

  /* A ring round every CATALOGUED OBJECT — the same annotation ASTAP draws
   * on a solved frame, but on the whole dome at once: M, NGC, IC and OCl at
   * their true positions and their true angular sizes.
   *
   * The first version of this ringed each PHOTOGRAPH's footprint instead.
   * That drew the album's own plates, which the pictures already show — it
   * answered "where have I pointed?" when the question is "what is that?".
   *
   * The objects come from gallery.js via setCatalog(), already merged from
   * catalog.json and openngc.json and already in degrees.
   *
   * Coloured by type, as ASTAP does, because the colour is the fastest part
   * to read: a glance says "galaxies here, clusters there" without a label
   * being drawn at all.
   *
   * Default OFF: this is deliberately busy, which is the point when you
   * want it and noise when you do not. */
  const OBJ_SEGMENTS = 36;
  // Sorted longest-prefix-free; first match wins.
  const OBJ_KIND = [
    [/globular/i,               [1.00, 0.85, 0.35, 0.85]],  // amber
    [/open cluster|association/i, [1.00, 0.95, 0.55, 0.75]], // pale gold
    [/planetary/i,              [0.60, 1.00, 0.85, 0.85]],  // mint
    [/nebula|hii|supernova/i,   [0.45, 0.95, 0.70, 0.80]],  // green
    [/galaxy|galaxies/i,        [1.00, 0.55, 0.45, 0.75]],  // salmon
  ];
  const OBJ_DEFAULT_RGBA = [0.75, 0.80, 0.90, 0.60];
  // A ring smaller than this on screen is a dot, and a screen full of dots
  // is noise. A ring larger than the view is not a ring, it is a line.
  const OBJ_MIN_PX = 5;
  const OBJ_MAX_RINGS = 500;
  /* IF YOU CAN SEE THE RING, YOU CAN READ ITS NAME. Set just under the
   * OBJ_MIN_PX floor so every ring that gets drawn also qualifies for a
   * label — the two constants are related and must stay that way.
   *
   * A size gate here was wrong in principle, and measurably wrong in fact.
   * Rings are floored at OBJ_MIN_PX, so an object whose true angular radius
   * never reaches the gate at ANY zoom is drawn forever at the floor and
   * named never: 46 of the 826 catalogued objects were in that state at a
   * 9 px gate, mostly compact planetary nebulae, the smallest 1.2 arcsec
   * across. You could not zoom in far enough, because there was no far
   * enough.
   *
   * Clutter is held off by the spacing test and the cap below instead,
   * which is the right place for it: those measure whether a name would be
   * READABLE, where a size gate only measured whether the object was big. */
  const OBJ_LABEL_MIN_PX = 4;
  const OBJ_MAX_LABELS = 44;
  // Minimum spacing between two names, in CSS pixels. Below this they
  // overlap into a smear and neither can be read.
  const OBJ_LABEL_MIN_GAP_X = 54;
  const OBJ_LABEL_MIN_GAP_Y = 13;

  let circlesOn = domeLsGet("dome.circles") === "1";
  let circleBuf = null;
  let catalogue = [];          // {id, n, ra, dec, r, t, m, dir}
  let objLabelLayer = null;

  /* Which names are worth keeping when two want the same patch of screen.
   * Lower wins. A Messier number or a real name ("Lagoon Nebula") beats an
   * anonymous IC number, and something bright beats something faint —
   * because the reader is orienting themselves, and "M 20" does that where
   * "IC 4678" does not. Size breaks the remaining ties. */
  function labelRank(o) {
    const named = /^M\d+$/i.test(o.id) || (o.n && o.n !== o.id);
    const bright = typeof o.m === "number" && o.m < 10;
    return (named ? 0 : 2) + (bright ? 0 : 1);
  }

  /* Drop every label element and the references to them.
   *
   * The labels are DOM spans held by `o._el` on the catalogue entry that
   * created them. gallery.js calls setCatalog() on EVERY openDome(), which
   * replaces `catalogue` wholesale — so without this the old spans stay in
   * the layer with nothing left pointing at them. They are hidden while the
   * overlay is, then reappear on the next open and can never be cleared,
   * because updateObjectLabels() walks the NEW catalogue and never sees
   * them. That is the "labels stuck on the dome after leaving and coming
   * back" fault. */
  function clearObjectLabels() {
    for (const o of catalogue) {
      if (o._el && o._el.remove) o._el.remove();
      o._el = null;
    }
    // Belt and braces: anything orphaned by an earlier catalogue swap is
    // not reachable through `catalogue` at all, so sweep the layer too.
    if (objLabelLayer) {
      while (objLabelLayer.firstChild) {
        objLabelLayer.removeChild(objLabelLayer.firstChild);
      }
    }
  }

  function setCatalog(list) {
    clearObjectLabels();
    catalogue = (list || []).map((o) => ({
      ...o,
      dir: vec(o.ra * DEG, o.dec * DEG),   // precomputed once, not per frame
      raRad: o.ra * DEG,
      decRad: o.dec * DEG,
      rad: Math.max(o.r, 0) * DEG,
      rank: labelRank(o),
    }));
    // Biggest first, so the cap below keeps what is worth seeing rather than
    // whatever the file happened to list first.
    catalogue.sort((a, b) => b.rad - a.rad);
    imagedReady = false;
    schedule();
    return catalogue.length;
  }

  /* Keep only the objects that are actually IN a photograph.
   *
   * The published catalogue is not trimmed to the imaged sky — publish.py
   * keeps every entry of catalog.json outright, because the dome's search
   * box has to be able to find things nobody has shot. So circling all of
   * it put rings on sky the album has never pointed at, which is the
   * opposite of what the toggle is for.
   *
   * Tested exactly, through each frame's own WCS, rather than against its
   * circumscribed circle: a frame's circle is 27% larger than the frame,
   * and objects landing in that margin are the ones that looked wrong.
   *
   * The backdrop is excluded. It is a 1900 deg^2 wide-field shot that
   * exists as context, and counting it would mark most of the summer sky
   * as imaged. Computed once per (catalogue, shots) pair — it costs a
   * pass over both and nothing after that. */
  let imagedReady = false;

  function computeImaged() {
    imagedReady = true;
    if (!catalogue.length || !shots.length) return;
    const frames = shots.filter((s) => !s.bg && s.wcs && s.wcs.image_size);
    let n = 0;
    for (const o of catalogue) {
      // EVERY frame that contains it, not merely whether one does — the
      // click needs to choose between them.
      o.inShots = [];
      for (const s of frames) {
        // Cheap reject first: the frame's own reach. 186k exact projections
        // would otherwise run on every catalogue swap.
        const d = o.dir[0] * s.centre[0] + o.dir[1] * s.centre[1]
                + o.dir[2] * s.centre[2];
        if (d < Math.cos(s.radius + o.rad)) continue;
        const p = skyToPix(o.raRad, o.decRad, s.wcs);
        if (!p) continue;
        const [w, h] = s.wcs.image_size;
        if (p[0] >= 0 && p[0] < w && p[1] >= 0 && p[1] < h) {
          o.inShots.push(shots.indexOf(s));
        }
      }
      o.imaged = o.inShots.length > 0;
      if (o.imaged) n++;
    }
    markerCache = null;        // an amber ring may have just been earned
    return n;
  }

  /* The amber rings are "bright, and not in this album". That was written
   * as a hand-kept list, and a hand-kept list goes stale the night the
   * telescope points at one of them: M 22 was photographed, solved and put
   * on the dome, and its ring went on saying the album had never been
   * there. Reported by tests/dome_harness.js, which checks each ring
   * against the album's own coverage rather than against the list.
   *
   * So the list says what is WORTH marking and the coverage says whether
   * it still is. Same exact test the object circles use — through each
   * frame's own WCS, not its circumscribed circle, which is 27% larger
   * than the frame — and the backdrop excluded for the same reason: it is
   * a wide-field context shot and counting it would retire most of the
   * summer sky's rings at once.
   *
   * The other kinds are untouched. A galactic pole is not a wish list. */
  let markerCache = null;

  function markerIsImaged(m) {
    const d = markerDir(m);
    for (const s of shots) {
      if (s.bg || !s.wcs || !s.wcs.image_size) continue;
      const dot = d[0] * s.centre[0] + d[1] * s.centre[1] + d[2] * s.centre[2];
      if (dot < Math.cos(s.radius)) continue;          // cheap reject
      const p = skyToPix(m.ra * DEG, m.dec * DEG, s.wcs);
      if (!p) continue;
      const [w, h] = s.wcs.image_size;
      if (p[0] >= 0 && p[0] < w && p[1] >= 0 && p[1] < h) return true;
    }
    return false;
  }

  function activeMarkers() {
    if (markerCache) return markerCache;
    markerCache = !shots.length ? MARKERS
      : MARKERS.filter((m) => m.kind !== "target" || !markerIsImaged(m));
    // A retired ring's label is a DOM node updateMarkerLabels will never
    // visit again, so it would sit on screen with nothing under it.
    for (const m of MARKERS) {
      if (m._el && markerCache.indexOf(m) < 0) {
        m._el.remove();
        m._el = null;
      }
    }
    return markerCache;
  }

  /* Which photograph to open for an object that appears in several.
   *
   * DEEPEST WINS. Integration time is the honest measure of which frame
   * shows the thing best — it is what the album already ranks a card's
   * photographs by, and what the dome already weights overlapping
   * footprints by. A tie is broken at RANDOM rather than by list order,
   * because list order is really capture order, and always handing back
   * the same one of two equal frames hides the other for good. */
  function bestShotFor(o) {
    if (!o || !o.inShots || !o.inShots.length) return -1;
    let best = [], bestT = -Infinity;
    for (const i of o.inShots) {
      const t = Number(shots[i] && shots[i].integrationS) || 0;
      if (t > bestT) { bestT = t; best = [i]; }
      else if (t === bestT) best.push(i);
    }
    return best[Math.floor(Math.random() * best.length)];
  }

  /* The object circle under the cursor, or null.
   *
   * Inside the ring, or within a few pixels outside it, so a small ring is
   * still reachable without demanding pixel accuracy. Ties go to the
   * SMALLEST ring: a big nebula often has clusters inside it, and the
   * inner one is the thing being pointed at. */
  const OBJ_PICK_SLOP_PX = 10;

  function pickObject(clientX, clientY) {
    if (!circlesOn || !visibleCache.length) return null;
    const rect = canvas.getBoundingClientRect();
    const x = clientX, y = clientY;
    let hit = null;
    for (const o of visibleCache) {
      const q = screenAt(o.dir);
      if (!q) continue;
      const d = Math.hypot(q[0] - x, q[1] - y);
      if (d > o.drawPx + OBJ_PICK_SLOP_PX) continue;
      if (!hit || o.drawPx < hit.drawPx) hit = o;
    }
    return hit;
  }

  function objColour(t) {
    for (const [re, c] of OBJ_KIND) if (re.test(t)) return c;
    return OBJ_DEFAULT_RGBA;
  }

  /* On screen, imaged, and big enough to be worth a ring at this zoom.
   *
   * The result is CACHED for this frame and the labels are drawn from that
   * same list. They used to be drawn by walking the whole catalogue and
   * reading a `drawRad` left over from an earlier pass, so a label could be
   * placed for an object whose circle had been culled — a name floating
   * with no ring under it, which is exactly what "detached" looked like. */
  let visibleCache = [];

  function visibleObjects() {
    if (!catalogue.length) return (visibleCache = []);
    if (!imagedReady) computeImaged();
    const t = Math.tan(cam.fov * DEG / 2);
    const aspect = (canvas.width / canvas.height) || 1;
    const halfView = Math.atan(t * Math.hypot(1, aspect));
    // Radians per CSS pixel, so the size test is in the unit the viewer
    // actually perceives rather than in degrees of sky. Measured off the
    // canvas's CSS box, which is what the labels are positioned in too —
    // taking one from the backing store and the other from the CSS box put
    // the label at devicePixelRatio times the right offset.
    const cssH = Math.max(1, canvas.clientHeight || (canvas.height / (window.devicePixelRatio || 1)));
    const radPerPx = (cam.fov * DEG) / cssH;
    const minRad = OBJ_MIN_PX * radPerPx;
    const { f } = basis();
    const out = [];
    for (const o of catalogue) {
      if (!o.imaged) continue;
      const reach = halfView + o.rad;
      if (reach < Math.PI) {
        const d = o.dir[0] * f[0] + o.dir[1] * f[1] + o.dir[2] * f[2];
        if (d <= Math.cos(reach)) continue;
      }
      // Floored, not skipped: a small object still gets a findable ring.
      o.drawRad = Math.max(o.rad, minRad);
      o.drawPx = o.drawRad / radPerPx;
      out.push(o);
      if (out.length >= OBJ_MAX_RINGS) break;   // catalogue is size-sorted
    }
    return (visibleCache = out);
  }

  function drawObjectCircles(VP) {
    if (!circlesOn || !gridProg) return;
    const list = visibleObjects();
    if (!list.length) return;

    if (!circleBuf) circleBuf = gl.createBuffer();
    gl.useProgram(gridProg);
    gl.uniformMatrix4fv(gl.getUniformLocation(gridProg, "uVP"), false, VP);
    const pos = gl.getAttribLocation(gridProg, "aPos");
    const col = gl.getUniformLocation(gridProg, "uColor");
    gl.enableVertexAttribArray(pos);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    // Grouped by colour so the uniform changes a handful of times rather
    // than once per object — the same reason drawMarkers() batches by kind.
    const groups = new Map();
    for (const o of list) {
      const c = objColour(o.t);
      const key = c.join(",");
      let g = groups.get(key);
      if (!g) { g = { c, items: [] }; groups.set(key, g); }
      g.items.push(o);
    }
    const perRing = OBJ_SEGMENTS * 6;
    for (const g of groups.values()) {
      const verts = new Float32Array(g.items.length * perRing);
      let at = 0;
      for (const o of g.items) {
        at = smallCircle(o.dir, o.drawRad, OBJ_SEGMENTS, verts, at);
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, circleBuf);
      gl.bufferData(gl.ARRAY_BUFFER, verts, gl.DYNAMIC_DRAW);
      gl.vertexAttribPointer(pos, 3, gl.FLOAT, false, 0, 0);
      gl.uniform4f(col, g.c[0], g.c[1], g.c[2], g.c[3]);
      gl.drawArrays(gl.LINES, 0, at / 3);
    }
    gl.disable(gl.BLEND);
    gl.enable(gl.DEPTH_TEST);
  }

  /* Names, as DOM over the canvas — the same approach as the marker labels,
   * and for the same reason: it is text.
   *
   * Only for rings big enough on screen to be worth naming, and capped. A
   * ring you can see is useful; four hundred overlapping names is not, and
   * ASTAP's own annotation thins them the same way. */
  function updateObjectLabels() {
    if (!objLabelLayer) return;
    if (!circlesOn) { objLabelLayer.style.display = "none"; return; }
    objLabelLayer.style.display = "";
    const rect = canvas.getBoundingClientRect();

    /* Only what was actually circled this frame, with the radius that was
     * actually drawn — so a name always sits on its own ring.
     *
     * Ordered by notability rather than by the draw order, which is size.
     * The spacing test below is first-come-first-served, so whatever leads
     * this list is what survives a crowded field: M 20 should win that
     * contest against a slightly larger anonymous IC number. */
    const drawn = visibleCache.slice()
      .sort((a, b) => (a.rank - b.rank) || (b.rad - a.rad));
    const live = new Set();
    const placed = [];      // [x, y] of labels already down, for spacing
    let shown = 0;

    for (const o of drawn) {
      if (shown >= OBJ_MAX_LABELS) break;
      if (o.drawPx < OBJ_LABEL_MIN_PX) continue;
      const q = screenAt(o.dir);
      if (!q) continue;
      const cx = q[0] - rect.left, cy = q[1] - rect.top;
      // The object's CENTRE decides whether it is on screen. The label then
      // sits under its ring — but a ring wider than the viewport would put
      // that below the bottom edge, and the biggest object in view is
      // exactly the one whose name you want. Clamp it back into the frame
      // rather than dropping it: zoomed into M 8, its own name was the one
      // going missing.
      if (cx < -40 || cx > rect.width + 40 || cy < -40 || cy > rect.height + 40) continue;
      const x = cx;
      const y = Math.max(10, Math.min(rect.height - 8, cy + o.drawPx + 4));
      // Two names on top of each other are worse than one name: the reader
      // gets a smear and cannot trust either. The catalogue is size-sorted,
      // so the one that wins the space is the larger object.
      let clash = false;
      for (const [px, py] of placed) {
        if (Math.abs(px - x) < OBJ_LABEL_MIN_GAP_X
            && Math.abs(py - y) < OBJ_LABEL_MIN_GAP_Y) { clash = true; break; }
      }
      if (clash) continue;

      let el = o._el;
      if (!el) {
        el = document.createElement("span");
        el.className = "dome-obj-label";
        el.textContent = o.n && o.n !== o.id && o.n.length <= 18 ? o.n : o.id;
        objLabelLayer.appendChild(el);
        o._el = el;
      }
      el.style.display = "";
      el.style.left = `${x.toFixed(0)}px`;
      el.style.top = `${y.toFixed(0)}px`;
      placed.push([x, y]);
      live.add(o);
      shown++;
    }
    // Everything else must go dark, including objects that were labelled a
    // frame ago and have since been culled.
    for (const o of catalogue) {
      if (o._el && !live.has(o)) o._el.style.display = "none";
    }
  }

  function setCircles(on) {
    circlesOn = !!on;
    const btn = document.getElementById("dome-circles-toggle");
    if (btn) {
      btn.classList.toggle("is-on", circlesOn);
      btn.setAttribute("aria-pressed", circlesOn ? "true" : "false");
    }
    domeLsSet("dome.circles", circlesOn ? "1" : "0");
    updateObjectLabels();
    schedule();
    return circlesOn;
  }

  function circlesBind() {
    objLabelLayer = document.getElementById("dome-obj-labels");
    const btn = document.getElementById("dome-circles-toggle");
    if (btn) btn.addEventListener("click", () => setCircles(!circlesOn));
    setCircles(circlesOn);
  }

  /* A brief outline round the frame the viewer arrived from.
   *
   * Coming here from an image in the album, "which of these plates is the
   * one I was just looking at?" has no answer once the camera lands —
   * every frame looks alike on the sphere, and neighbours overlap. This
   * says which one for a couple of seconds and then gets out of the way.
   *
   * DOM SVG rather than GL, for the same reasons the capture outline is:
   * it is a thin line drawn over the picture, it wants a CSS transition to
   * fade, and screenAt() already projects sky directions to screen pixels. */
  const HL_EDGE_SAMPLES = 10;
  const HL_HOLD_MS = 10000;      // owner asked for ~10 s of the yellow region rectangle
  const HL_FADE_MS = 700;
  let hlShot = null, hlTimer = null, hlFadeTimer = null;

  function hlPoints(s) {
    /* Sampled along each edge rather than drawn corner to corner. A 7-degree
     * mosaic's edge is a curve in the dome's projection, so a straight
     * four-point polygon visibly cuts its corners — the same reason the
     * capture guide is sampled. */
    const c = s.corners;
    const out = [];
    for (let e = 0; e < 4; e++) {
      const a = c[e], b = c[(e + 1) % 4];
      for (let i = 0; i < HL_EDGE_SAMPLES; i++) {
        const t = i / HL_EDGE_SAMPLES;
        out.push(norm3([a[0] + (b[0] - a[0]) * t,
                        a[1] + (b[1] - a[1]) * t,
                        a[2] + (b[2] - a[2]) * t]));
      }
    }
    return out;
  }

  function hlUpdateOverlay() {
    const svg = document.getElementById("dome-hl-svg");
    const poly = document.getElementById("dome-hl-poly");
    if (!svg || !poly || !canvas) return;
    if (!hlShot) { svg.hidden = true; return; }
    const rect = canvas.getBoundingClientRect();
    svg.hidden = false;
    svg.setAttribute("viewBox", `0 0 ${rect.width} ${rect.height}`);
    const pts = hlPoints(hlShot).map(screenAt);
    if (pts.some((q) => !q)) {
      // Part of the frame is behind the camera; the outline would fold
      // inside out, so draw nothing rather than a lie.
      poly.setAttribute("points", "");
      return;
    }
    poly.setAttribute("points", pts
      .map((q) => `${(q[0] - rect.left).toFixed(1)},${(q[1] - rect.top).toFixed(1)}`)
      .join(" "));
  }

  function highlightShot(s) {
    clearTimeout(hlTimer); clearTimeout(hlFadeTimer);
    hlShot = s || null;
    const svg = document.getElementById("dome-hl-svg");
    if (svg) svg.classList.remove("is-fading");
    hlUpdateOverlay();
    if (!hlShot) return;
    schedule();
    // Held through the ~780 ms flight and a beat after it lands, then faded.
    hlTimer = setTimeout(() => {
      if (svg) svg.classList.add("is-fading");
      hlFadeTimer = setTimeout(() => { hlShot = null; hlUpdateOverlay(); },
                               HL_FADE_MS);
    }, HL_HOLD_MS);
  }

  /* Brightness, driven exactly like the zoom bar: the same track geometry,
   * the same pointer capture, the same wheel and arrow keys. Sharing the
   * behaviour is the point — two controls on one rail that look alike and
   * then respond differently is worse than two that look different.
   *
   * Logarithmic in gain, because brightness is perceived that way and because
   * a linear 0.4-4.0 would spend two thirds of the track above 1.5x. */
  function gainPos(g) {
    return Math.log(g / GAIN_MIN) / Math.log(GAIN_MAX / GAIN_MIN);
  }
  function posGain(p) {
    return GAIN_MIN * Math.pow(GAIN_MAX / GAIN_MIN, Math.min(1, Math.max(0, p)));
  }

  /* `persist` is false while a drag is in flight so a storage write cannot
   * land between frames; the value is stored once on release. */
  function setGain(v, persist) {
    domeGain = clampGain(v);
    const p = gainPos(domeGain);
    const pct = `${(p * 100).toFixed(2)}%`;
    const fill = document.getElementById("dome-gain-fill");
    const mark = document.getElementById("dome-gain-marker");
    const out = document.getElementById("dome-gain-value");
    const track = document.getElementById("dome-gain-track");
    if (fill) fill.style.height = pct;
    if (mark) mark.style.bottom = pct;
    // The exact number, because every other figure the album prints is exact.
    if (out) out.textContent = `${domeGain.toFixed(2)}×`;
    if (track) {
      track.setAttribute("aria-valuenow", String(Math.round(p * 100)));
      track.setAttribute("aria-valuetext", `${domeGain.toFixed(2)} times`);
    }
    if (persist !== false) domeLsSet(GAIN_KEY, String(domeGain));
    schedule();
    return domeGain;
  }

  function buildGainScale() {
    const track = document.getElementById("dome-gain-track");
    if (!track) return;
    track.querySelectorAll(".dome-gain-tick").forEach((n) => n.remove());
    for (const g of [0.5, 1, 2, 4]) {
      if (g < GAIN_MIN || g > GAIN_MAX) continue;
      const el = document.createElement("i");
      el.className = "dome-gain-tick";
      el.style.bottom = `${(gainPos(g) * 100).toFixed(2)}%`;
      el.innerHTML = `<b>${g === 1 ? "measured" : g + "×"}</b>`;
      track.appendChild(el);
    }
  }

  function gainBind() {
    const wrap = document.getElementById("dome-gain");
    const track = document.getElementById("dome-gain-track");
    if (!wrap || !track) return;
    buildGainScale();

    let grabbed = false;
    const fromY = (clientY) => {
      const r = track.getBoundingClientRect();
      setGain(posGain(1 - (clientY - r.top) / (r.height || 1)), false);
    };
    wrap.addEventListener("pointerdown", (e) => {
      grabbed = true;
      wrap.classList.add("is-grabbed");
      try { wrap.setPointerCapture(e.pointerId); } catch (_) {}
      fromY(e.clientY);
      e.preventDefault();
    });
    wrap.addEventListener("pointermove", (e) => { if (grabbed) fromY(e.clientY); });
    const drop = (e) => {
      if (!grabbed) return;
      grabbed = false;
      wrap.classList.remove("is-grabbed");
      try { wrap.releasePointerCapture(e.pointerId); } catch (_) {}
      domeLsSet(GAIN_KEY, String(domeGain));   // store once, on release
    };
    wrap.addEventListener("pointerup", drop);
    wrap.addEventListener("pointercancel", drop);
    // Scrolling over the bar adjusts it, so the pointer does not have to
    // travel back to the sky to keep going — as on the zoom bar.
    wrap.addEventListener("wheel", (e) => {
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      const d = Math.max(-400, Math.min(400, e.deltaY * unit));
      setGain(domeGain * Math.exp(-d * 0.0015), true);
    }, { passive: false });
    // No reset button: the rail is narrow and a double-click is the gesture
    // people already try on a slider they have pushed too far.
    wrap.addEventListener("dblclick", (e) => {
      e.preventDefault();
      setGain(GAIN_DEFAULT, true);
    });
    track.addEventListener("keydown", (e) => {
      const step = e.shiftKey ? 4 : 1;
      if (e.key === "ArrowUp" || e.key === "ArrowRight") setGain(domeGain * Math.pow(1.1, step), true);
      else if (e.key === "ArrowDown" || e.key === "ArrowLeft") setGain(domeGain / Math.pow(1.1, step), true);
      else if (e.key === "Home") setGain(GAIN_MIN, true);
      else if (e.key === "End") setGain(GAIN_MAX, true);
      else return;
      e.preventDefault();
    });
    setGain(domeGain, false);
  }

  function circlePole(c) {
    if (c.pole) return c.pole;
    if (typeof c.obliquity === "number") {
      // Rotate +z about the +x axis (the vernal equinox) by the obliquity.
      const e = c.obliquity * DEG;
      return [0, -Math.sin(e), Math.cos(e)];
    }
    return vec(c.ra * DEG, c.dec * DEG);
  }

  function buildGrid() {
    const v = [];
    const push = (ra, dec) => { const p = vec(ra, dec); v.push(p[0], p[1], p[2]); };
    // Meridians every 30 deg of RA (2h), parallels every 30 deg of Dec.
    for (let raDeg = 0; raDeg < 360; raDeg += 30) {
      for (let d = -90; d < 90; d += 3) {
        push(raDeg * DEG, d * DEG);
        push(raDeg * DEG, (d + 3) * DEG);
      }
    }
    for (let decDeg = -60; decDeg <= 60; decDeg += 30) {
      for (let a = 0; a < 360; a += 3) {
        push(a * DEG, decDeg * DEG);
        push((a + 3) * DEG, decDeg * DEG);
      }
    }
    gridCount = v.length / 3;
    // Each reference circle appends its own run and records where it
    // starts, so draw() can give each one its own colour in one buffer.
    let at = gridCount;
    const all = v.slice();
    for (const c of CIRCLES) {
      const seg = greatCircle(circlePole(c), 2);
      all.push(...seg);
      c.first = at;
      c.count = seg.length / 3;
      at += c.count;
    }
    gridBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, gridBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(all), gl.STATIC_DRAW);
    return at - gridCount;
  }

  // ── Textures ──────────────────────────────────────────────────────
  /* Textures are non-power-of-two, so no mipmaps and no REPEAT — LINEAR
   * with CLAMP_TO_EDGE, which WebGL 1 does allow for NPOT. Minification
   * aliasing is handled by not keeping an oversized tier around: a frame
   * only holds a detail texture while it is being looked at closely. */
  const isPot = (n) => n > 0 && (n & (n - 1)) === 0;

  function upload(img) {
    const t = gl.createTexture();
    // Remembered on the texture so the erosion tap in dataAt() can be sized
    // in TEXELS of whichever tier is bound. Guessing a fixed size would
    // erode a 512 px tier eight times as far as a 4096 px one.
    t.texW = img.naturalWidth || img.width || 1024;
    t.texH = img.naturalHeight || img.height || 1024;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, img);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    // Mipmaps, which is the whole reason publish.py ships power-of-two
    // textures. A frame drawn smaller than its texture samples one texel
    // in ten without them, and a star field under that treatment crawls
    // and sparkles every time the view moves — worst on exactly the frames
    // that have been zoomed into, because they hold the largest texture.
    if (isPot(img.naturalWidth || img.width)
        && isPot(img.naturalHeight || img.height)) {
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER,
                       gl.LINEAR_MIPMAP_LINEAR);
      // Trilinear alone over-blurs a footprint seen at a slant, which at
      // the edge of a wide view is most of them.
      if (aniso) {
        gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT,
                         anisoMax);
      }
    } else {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    }
    return t;
  }

  /* Tier 0 — a few KB, loaded for every frame when the dome opens and kept
   * for the rest of the session. It is what a frame falls back to when its
   * detail texture is evicted, so it is never released. */
  function loadBase(s) {
    if (s.baseTex || s.baseLoading) return;
    s.baseLoading = true;
    const img = new Image();
    img.decoding = "async";
    // schedule(), not draw(): every frame in the album calls this once as
    // the dome opens, and a direct draw() made that N synchronous full
    // redraws — 175 of them, back to back, each walking every visible
    // footprint — where requestAnimationFrame collapses the burst into
    // one redraw per displayed frame. This is the opening stutter.
    img.onload = () => { s.baseTex = upload(img); releaseImage(img); schedule(); };
    img.onerror = () => { s.baseLoading = false; };
    img.src = s.levels[0].src;
  }

  /* Hand a decoded image back once its pixels are on the GPU.
   *
   * The texture is a copy. The <img> still holds its own decoded bitmap
   * until the element is collected, and Safari in particular keeps that
   * alive long after the last reference goes — an 8192 px tier is 134 MB of
   * it, counted by no budget. Removing src releases it now. Handlers are
   * dropped first so the release cannot re-enter onload/onerror. */
  function releaseImage(img) {
    img.onload = img.onerror = null;
    if (typeof img.removeAttribute === "function") img.removeAttribute("src");
  }

  /* Every detail texture back to tier 0, and every fetch still in flight
   * abandoned. For when nobody can see the dome: closed, or the tab hidden.
   * Tier 0 stays — a few KB a frame, and what a reopen draws first. */
  function releaseAllDetail() {
    for (const s of shots) {
      if (s.pendingImg) s.pendingImg.cancel();
      releaseDetail(s);
    }
  }

  /* The tier this frame would need for one texture pixel per screen pixel
   * at a given field. Capped at what the frame actually ships: a source
   * that was only 1182 px wide has no 2560 px tier, and asking for one
   * would 404 on every settle. Takes the field as an argument so a fly-to
   * can order the tier it is about to need rather than the one it is
   * leaving. */
  function wantedLevelAt(s, fov) {
    const need = s.degLong * surfaceH() / fov;
    for (let i = 0; i < s.levels.length; i++) {
      if (s.levels[i].px >= need) return Math.min(i, s.maxLevel);
    }
    return s.maxLevel;
  }

  function wantedLevel(s) { return wantedLevelAt(s, cam.fov); }

  function centreDot(s) {
    const { f } = basis();
    return s.centre[0] * f[0] + s.centre[1] * f[1] + s.centre[2] * f[2];
  }

  /* Is any part of this frame inside the frustum? Compared against the
   * half-diagonal rather than the vertical half-angle, so a frame in a
   * corner is not treated as off screen. */
  function onScreen(s) {
    const t = Math.tan(cam.fov * DEG / 2);
    const aspect = (canvas.width / canvas.height) || 1;
    const half = Math.atan(t * Math.hypot(1, aspect)) + s.radius;
    return half >= Math.PI || centreDot(s) > Math.cos(half);
  }

  function releaseDetail(s) {
    if (!s.detailTex) return;
    gl.deleteTexture(s.detailTex);
    detailBytes -= s.detailBytes;
    s.detailTex = null; s.detailBytes = 0; s.detailLevel = 0;
  }

  /* Detail textures are big enough that a session wandering the album would
   * grow without bound. Drop the least-recently-looked-at back to tier 0
   * until the budget is met; never the frame that just arrived. */
  function evict(keep) {
    if (detailBytes <= DETAIL_BUDGET) return;
    // Off-screen frames go first, least recently looked at within each
    // group. Evicting purely by recency dropped frames that were ON SCREEN
    // and still wanted, and refine() ordered them straight back — whose
    // arrival evicted the next visible frame, and so on for as long as the
    // tab stayed open, with no input at all. Zoomed in past ~2 deg a couple
    // of 8192 px tiers exceed the budget together, so that loop downloaded,
    // decoded and uploaded 134 MB images back to back: the "endless
    // sharpening", and the memory and swap growth of a tab left sitting on
    // the dome.
    const held = shots.filter((s) => s.detailTex && s !== keep)
                      .sort((a, b) => (onScreen(a) - onScreen(b))
                                      || (a.used - b.used));
    for (const s of held) {
      if (detailBytes <= DETAIL_BUDGET) break;
      releaseDetail(s);
    }
  }

  /* `volatile` means "ordered for the view as it stands", and only refine()
   * may set it. Such a load is allowed to be abandoned — cancelled in
   * flight, or discarded on arrival — if the viewer has moved on.
   *
   * The other two callers must NOT be judged that way. A capture
   * deliberately loads tiers finer than the current zoom wants (see the
   * long note in refine()), and flyTo() orders the tier for where it is
   * GOING, not where it is. Judging either against the camera as it stands
   * would throw away exactly the texture that was asked for. */
  function loadDetail(s, li, volatile) {
    if (li <= s.detailLevel || li <= s.pendingLevel || li > s.maxLevel) return;
    s.pendingLevel = li;
    inflight++;
    updateHud();
    const img = new Image();
    img.decoding = "async";
    let cancelled = false;
    const done = () => {
      inflight--; s.pendingLevel = -1; s.pendingImg = null; updateHud();
    };
    /* Cancelling is what keeps a zoomed-in pan from stalling. A tier
     * ordered for a frame the viewer has since panned past would otherwise
     * still finish downloading, still block the main thread uploading up to
     * 8192 px, and still evict a texture that IS on screen — then requeue
     * another pass. That is the "keeps sharpening" stutter. */
    s.pendingImg = {
      level: li,
      volatile: !!volatile,
      cancel: () => {
        if (cancelled) return;
        cancelled = true;
        img.src = "";           // asks the browser to stop fetching
        done();
      },
    };
    img.onload = () => {
      if (cancelled) return;
      // Still worth having by the time it arrived? Off screen, or finer
      // than the view now needs, it is not. A tier COARSER than wanted is
      // kept: refine() orders one on purpose when the budget cannot hold the
      // wanted tier, and discarding it for not being the wanted one re-ordered
      // the same tier forever.
      if (volatile && (!onScreen(s) || li > wantedLevel(s) || li <= s.detailLevel)) {
        releaseImage(img);
        done();
        refineSoon(SETTLE_MS);
        return;
      }
      // The frame keeps whatever it was already showing until this decodes,
      // so zooming in sharpens rather than blinking through an empty plate.
      if (s.detailTex) {
        gl.deleteTexture(s.detailTex);
        detailBytes -= s.detailBytes;
      }
      s.detailTex = upload(img);
      s.detailBytes = img.naturalWidth * img.naturalHeight * 4;
      releaseImage(img);
      s.detailLevel = li;
      s.used = ++useStamp;
      detailBytes += s.detailBytes;
      evict(s);
      done();
      schedule();
      // A frame may need more than one step up if the viewer zoomed a long
      // way in one gesture; picking the next rung happens on the next pass.
      // Through the settle debounce, not immediately: firing at zero delay
      // meant every completed load started another pass at once, so a pan
      // over big tiers never got a quiet moment.
      refineSoon(SETTLE_MS);
    };
    img.onerror = () => {
      // A cancellation reports as an error. Truncating the ladder here
      // would permanently cap the frame at a tier it can actually serve.
      if (cancelled) return;
      // Treat a missing tier as the top of this frame's ladder rather than
      // retrying it on every settle for the rest of the session.
      s.maxLevel = li - 1;
      done();
    };
    img.src = s.levels[li].src;
  }

  /* Ask for sharper textures for what is on screen, middle of the view
   * first. Runs once the camera settles rather than on every wheel tick, so
   * a long zoom fetches the tier you land on and not every tier you passed
   * through on the way. */
  function refine() {
    if (!ready || !opened) return;
    /* Not while a capture is loading.
     *
     * The release pass below hands back any texture finer than the CURRENT
     * ZOOM needs. A capture deliberately loads tiers finer than that — it
     * renders at the sharpest sampling the album holds, whatever the view
     * happens to be — and loadDetail's onload calls refineSoon(0), so each
     * tier that arrived was released again a moment later. Zoomed in the
     * zoom happened to want them and they survived; zoomed out it did not
     * and the capture rendered from tier 0, magnified. Same region, same
     * output size, one sharp and one with no detail in it at all
     * (high-frequency std 5.40 against 0.36 on the two reported files).
     *
     * Refining also competes for the in-flight slots the capture is using,
     * so there is nothing here worth doing until it finishes. */
    if (capBusy) return;
    // Give back detail a frame no longer needs. Zooming out used to leave
    // every frame holding whatever texture its closest approach had earned,
    // so a wide view was drawn from textures ten times finer than the
    // pixels available — which is both wasted memory and, before mipmaps,
    // the source of the shimmer. A full tier of hysteresis, since the
    // ladder steps in factors of four.
    for (const s of shots) {
      if (s.detailTex && wantedLevel(s) < s.detailLevel) releaseDetail(s);
    }
    // Stop fetching tiers nobody is looking at any more, and free the
    // in-flight slot for a frame that IS on screen. Only volatile loads —
    // a capture's and a flight's are still wanted whatever the camera is
    // doing right now.
    for (const s of shots) {
      const p = s.pendingImg;
      // Finer than now needed, not merely different: a coarser tier ordered
      // because the budget could not hold the wanted one is still wanted.
      if (p && p.volatile && (!onScreen(s) || p.level > wantedLevel(s))) {
        p.cancel();
      }
    }
    const visible = shots.filter(onScreen);
    // Looking at a frame counts as using it, so the eviction order tracks
    // where the viewer has been rather than only what has been downloaded.
    for (const s of visible) if (s.detailTex) s.used = ++useStamp;
    /* Order only what the budget can HOLD alongside what is already on
     * screen. Ordering the wanted tier regardless is what started the
     * endless-sharpening loop (see evict): the visible set's wanted tiers
     * did not fit, so each arrival evicted a visible neighbour that the next
     * pass ordered again. A frame gets the finest tier that fits, centre of
     * the view first; one that fits nothing better than it holds is left
     * alone, and the pass ends instead of cycling. Off-screen textures are
     * not counted — evict() gives those up first. */
    let committed = 0;
    for (const s of visible) if (s.detailTex) committed += s.detailBytes;
    for (const s of shots) if (s.pendingLevel > 0) committed += capTierBytes(s, s.pendingLevel);
    let slots = Math.max(0, MAX_INFLIGHT - inflight);
    const hungry = visible
      .filter((s) => s.pendingLevel < 0 && wantedLevel(s) > s.detailLevel)
      .sort((a, b) => centreDot(b) - centreDot(a));
    for (const s of hungry) {
      if (!slots) break;
      const held = s.detailTex ? s.detailBytes : 0;
      let li = wantedLevel(s);
      while (li > s.detailLevel && committed - held + capTierBytes(s, li) > DETAIL_BUDGET) li--;
      if (li <= s.detailLevel) continue;
      committed += capTierBytes(s, li) - held;
      loadDetail(s, li, true);
      slots--;
    }
    updateHud();
  }

  function refineSoon(delay) {
    clearTimeout(refineTimer);
    refineTimer = setTimeout(refine, delay === undefined ? SETTLE_MS : delay);
  }

  // ── Draw ──────────────────────────────────────────────────────────
  /* Footprints, accumulated and composited. Pass 3 + 4 of draw(), lifted
   * out because a custom capture needs exactly this and must not be a
   * second, drifting copy of it: the data-aware coverage, the depth
   * weighting and the divide-once composite are what make a stitch of
   * several frames read as one photograph, and a capture that reimplemented
   * them would quietly disagree with the dome it was taken from.
   *
   * Averaging by DATA rather than by footprint is what stops an unfinished
   * mosaic from darkening everything under its empty area.
   *
   *   VP       view-projection to render through
   *   vis      indices of the frames to draw
   *   W, H     target size in pixels
   *   feather  texels of edge ramp (0 for the dome, > 0 for a capture)
   *   outFB    framebuffer to composite into (null = the canvas)
   */
  /* gain applies to the on-screen dome only. A capture passes 1.0: the file
   * it produces carries the region and the frame list stamped into it, and a
   * saved photograph whose brightness depended on where a slider happened to
   * be would make that provenance a lie. */
  function footprintPass(VP, vis, W, H, feather, outFB, gain) {
    const accOK = !!fullProg && ensureAccum(W, H);
    if (accOK) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, accFB);
      gl.viewport(0, 0, W, H);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(prog);
    gl.uniformMatrix4fv(gl.getUniformLocation(prog, "uVP"), false, VP);
    gl.uniform1f(gl.getUniformLocation(prog, "uAccScale"),
                 (accOK && !accHalf) ? 1.0 / ACC_SCALE : 1.0);
    gl.uniform1f(gl.getUniformLocation(prog, "uFeather"), feather || 0);
    const aPos = gl.getAttribLocation(prog, "aPos");
    const aUV = gl.getAttribLocation(prog, "aUV");
    const uHas = gl.getUniformLocation(prog, "uHasTex");
    const uTexel = gl.getUniformLocation(prog, "uTexel");
    const uWeight = gl.getUniformLocation(prog, "uWeight");
    const uPedestal = gl.getUniformLocation(prog, "uPedestal");
    // A custom capture composites the same frames through this pass into its
    // own framebuffer, and it must always render the sky as it really is —
    // so the opening lift applies to the dome's own draw (outFB null) and
    // never to a capture that happens to be taken while one is running.
    const uSpin = gl.getUniformLocation(prog, "uSpin");
    // A custom capture composites the same frames through this pass into
    // its own framebuffer, and must always render the sky as it really is
    // — so the opening flight applies to the dome's own draw (outFB null)
    // and never to a capture taken while one is running.
    const lifting = !outFB;
    gl.uniform1i(gl.getUniformLocation(prog, "uTex"), 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.enableVertexAttribArray(aPos);
    gl.enableVertexAttribArray(aUV);
    for (const i of vis) {
      const s = shots[i];
      gl.bindBuffer(gl.ARRAY_BUFFER, s.pos);
      gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, s.uv);
      gl.vertexAttribPointer(aUV, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, s.idxBuf);
      // Sharpest tier this frame currently holds. Falls back to tier 0 the
      // moment a detail texture is evicted, so a frame never goes blank.
      const tex = s.detailTex || s.baseTex;
      if (tex) {
        gl.bindTexture(gl.TEXTURE_2D, tex); gl.uniform1f(uHas, 1);
        gl.uniform2f(uTexel, 1.0 / (tex.texW || 1024), 1.0 / (tex.texH || 1024));
      } else {
        // No texture yet. uTexel still has to be something: edgeFade divides
        // by it, and a stale or zero value is a division by zero whose
        // result is undefined — on some drivers NaN, which then poisons the
        // accumulated coverage and makes the whole composite discard.
        gl.uniform1f(uHas, 0);
        gl.uniform2f(uTexel, 1 / 1024, 1 / 1024);
      }
      const share = (lifting && flightShotIdx >= 0 && i !== flightShotIdx) ? (1 - flightBlend) : 1;
      gl.uniform1f(uWeight, depthWeight(effectiveIntegration(s), accOK && accHalf) * share);
      // EVERY frame, not only the flight's: the lift eases out over the whole
      // zoom (the owner wants the brightness to move as gradually as the
      // picture does), and by then the neighbours are in view. Lifting only
      // one frame would show it as a bright rectangle against flattened
      // neighbours for most of the flight. Never in a capture, which must
      // render the sky as it really is.
      gl.uniform1f(uPedestal, lifting ? flightPedestal : 0);
      gl.uniformMatrix3fv(uSpin, false, lifting ? introSpin(s, animNow) : IDENT3);
      gl.drawElements(gl.TRIANGLES, s.count, gl.UNSIGNED_SHORT, 0);
    }

    // Composite: divide colour by coverage, once. Alpha is zero where no
    // frame held light, so those pixels keep whatever is underneath
    // instead of a black patch.
    if (accOK) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, outFB || null);
      gl.viewport(0, 0, W, H);
      gl.useProgram(fullProg);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      const fPos = gl.getAttribLocation(fullProg, "aXY");
      gl.bindBuffer(gl.ARRAY_BUFFER, fullBuf);
      gl.enableVertexAttribArray(fPos);
      gl.vertexAttribPointer(fPos, 2, gl.FLOAT, false, 0, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, accTex);
      gl.uniform1i(gl.getUniformLocation(fullProg, "uAcc"), 0);
      gl.uniform1f(gl.getUniformLocation(fullProg, "uGain"),
                   gain == null ? 1 : gain);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.disableVertexAttribArray(fPos);
    }
    return accOK;
  }

  // ── Opening flight ────────────────────────────────────────────────
  /* The photographs arrive rather than being already there — but only the
   * ones in view, a few dozen at a time, from close to where they belong.
   *
   * It used to be the whole album at once. Every frame set off from a random
   * point on the SPHERE, so every frame had to be drawn and given a spin
   * matrix on every tick for three seconds — including the ones behind the
   * camera, since any of them might cross the view on its way home — and the
   * opening's own loop and schedule() both drew, often twice a display
   * frame. Measured in the harness at the 60 degree opening view: 190.7 draws
   * and 171.7 spin uploads per tick, for 132 frames actually on screen. That
   * is the lag when the dome opens.
   *
   * Now three waves, each local to where the viewer is looking:
   *
   *   open  the frames inside the view (plus ANIM_MARGIN) fly in from a
   *         point near home, middle of the view first;
   *   pan   a frame that comes into view later arrives the same way, once,
   *         and is settled from then on;
   *   tap   flyTo() ripples a few frames around the DESTINATION as the
   *         camera lands (animTap) — never the sky the flight crosses.
   *
   * At most ANIM_MAX run at once and at most ANIM_STARTS_PER_TICK begin in
   * one tick, so zooming out over M 8 / M 20 / M 24 staggers its arrivals
   * instead of starting dozens of tweens in a single frame. A frame waiting
   * its turn to ARRIVE is not drawn — it has not arrived — while a frame
   * waiting to RIPPLE stays drawn at home, because it is already there.
   * Anything that leaves the view mid-flight takes its final state at once,
   * and when nothing is moving or queued the render loop stops.
   *
   * The motion is the same in kind as before: a rotation from the start
   * point to home about the axis perpendicular to both — the great circle,
   * the short way round — with a roll about the frame's own centre riding
   * along. That keeps every frame ON the sphere at its true size, and at
   * rest the rotation is exactly the identity. Only the start point moved:
   * near home, not anywhere on the sky. An arrival decays as (1-p)³, quick
   * at first and slow into the last of it; a ripple lifts and settles back.
   */
  const INTRO_MS = 1500;           // no frame of the opening takes longer
  const OPEN_MIN_MS = 1000;        // …and the quickest lands here
  const PAN_MS = [700, 1100];      // a frame panned into view
  const TAP_MS = [650, 950];       // a ripple around a destination
  const INTRO_SPIN = 2.2;          // radians of roll to unwind, at most
  const ANIM_MAX = 48;             // tweens live at once
  const ANIM_STARTS_PER_TICK = 6;  // tweens allowed to begin in one tick
  const ANIM_MARGIN = 0.15;        // beyond the view's half-diagonal
  const ANIM_TRAVEL_MAX_DEG = 12;  // furthest a frame sets off from home
  const TAP_RADII = 3;             // neighbourhood, in destination radii…
  const TAP_MAX = 12;              // …and never more frames than this
  const TAP_STAGGER_MS = 40;       // spreading outward from the destination
  // sin(πp)(1-p) peaks near 0.58; scaled so a ripple reaches its full lift.
  const RIPPLE_NORM = 1 / 0.58;
  const animLive = new Set();      // shots mid-tween
  let animQueue = [];              // shots waiting their turn
  let animWave = "";               // "open" until the opening wave is queued
  let animNow = 0;                 // one clock per draw, read by every frame
  let animPeakLive = 0, animPeakStarts = 0;
  // Reused across every frame of every shot: this runs per shot per draw,
  // and allocating a matrix each time would make the flight the only part
  // of the dome that produces garbage.
  const IDENT3 = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  const introTravelBuf = new Float32Array(9);
  const introRollBuf = new Float32Array(9);
  const introSpinBuf = new Float32Array(9);

  /* Rotation about a unit axis, written straight into the column-major
   * order WebGL wants (element [col*3 + row]) rather than being built
   * row-wise and transposed. */
  function rotAbout(axis, a, out) {
    const c = Math.cos(a), sn = Math.sin(a), t = 1 - c;
    const x = axis[0], y = axis[1], z = axis[2];
    out[0] = c + x * x * t;
    out[1] = y * x * t + z * sn;
    out[2] = z * x * t - y * sn;
    out[3] = x * y * t - z * sn;
    out[4] = c + y * y * t;
    out[5] = z * y * t + x * sn;
    out[6] = x * z * t + y * sn;
    out[7] = y * z * t - x * sn;
    out[8] = c + z * z * t;
    return out;
  }

  /* C = A·B, both column-major. C[col][row] = sum_k A[k][row] · B[col][k].
   *
   * NOT mul3 — that name is taken further down by the vector-times-scalar
   * helper the capture geometry runs on, and a second function declaration
   * of the same name in the same scope simply replaces the first. Calling
   * this one mul3 quietly turned every matrix product into a vector scaled
   * by a matrix, which is NaN; and had the two been declared the other way
   * round it would have been the capture that broke instead, silently. */
  function mulMat3(a, b, out) {
    for (let col = 0; col < 3; col++) {
      for (let row = 0; row < 3; row++) {
        out[col * 3 + row] = a[row] * b[col * 3]
                           + a[3 + row] * b[col * 3 + 1]
                           + a[6 + row] * b[col * 3 + 2];
      }
    }
    return out;
  }

  // Motion turned down: the map is simply there, which is also the fastest
  // way to read it.
  function motionOK() {
    return !(typeof window !== "undefined" && window.matchMedia
             && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }

  /* Settle everything now: what is moving lands, what is waiting is
   * dropped, and every frame counts as arrived. Close, a hidden tab and a
   * new opening all start from here. */
  function introStop() {
    for (const s of animLive) s.anim = null;
    animLive.clear();
    for (const s of animQueue) s.anim = null;
    animQueue = [];
    animWave = "";
    for (const s of shots) s.arrived = true;
  }

  /* A point `ang` radians from the unit vector `c`, in a random direction
   * along the sphere. */
  function nearby(c, ang) {
    const t = Math.abs(c[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    let ux = c[1] * t[2] - c[2] * t[1];
    let uy = c[2] * t[0] - c[0] * t[2];
    let uz = c[0] * t[1] - c[1] * t[0];
    const ul = Math.hypot(ux, uy, uz) || 1;
    ux /= ul; uy /= ul; uz /= ul;
    const vx = c[1] * uz - c[2] * uy;
    const vy = c[2] * ux - c[0] * uz;
    const vz = c[0] * uy - c[1] * ux;
    const phi = Math.random() * 2 * Math.PI;
    const dx = Math.cos(phi), dy = Math.sin(phi);
    const ca = Math.cos(ang), sa = Math.sin(ang);
    return [c[0] * ca + (ux * dx + vx * dy) * sa,
            c[1] * ca + (uy * dx + vy * dy) * sa,
            c[2] * ca + (uz * dx + vz * dy) * sa];
  }

  function between(lo, hi) { return lo + Math.random() * (hi - lo); }

  /* Give a frame its journey, queued. "arrive" is a frame not yet seen: it
   * starts away from home and is drawn only once its turn comes. "ripple"
   * is a frame already home: it lifts a little and settles back. The reach
   * scales with the field, so a wide view's arrival reads as arriving and a
   * zoomed-in one does not throw frames off the screen. */
  function animAssign(s, wave, kind) {
    const reach = Math.min(ANIM_TRAVEL_MAX_DEG * DEG,
                           Math.max(1.2 * s.radius, 0.22 * cam.fov * DEG));
    let ang, rot, dur;
    if (kind === "ripple") {
      ang = between(0.15, 0.35) * s.radius;
      rot = between(-0.35, 0.35);
      dur = between(TAP_MS[0], TAP_MS[1]);
    } else if (wave === "open") {
      ang = between(0.4, 1) * reach;
      rot = between(-1, 1) * INTRO_SPIN;
      dur = between(OPEN_MIN_MS, INTRO_MS);
    } else {
      ang = between(0.25, 0.6) * reach;
      rot = between(-1, 1) * 1.2;
      dur = between(PAN_MS[0], PAN_MS[1]);
    }
    const c = s.centre;
    const q = nearby(c, ang);
    // Axis and angle carrying the frame's real direction to the start:
    // turned by the whole angle when it sets off, by nothing when it lands.
    const kx = c[1] * q[2] - c[2] * q[1];
    const ky = c[2] * q[0] - c[0] * q[2];
    const kz = c[0] * q[1] - c[1] * q[0];
    const kl = Math.hypot(kx, ky, kz) || 1;
    s.anim = {
      wave, kind, state: "queued", t0: 0, dur, rot,
      axis: [kx / kl, ky / kl, kz / kl],
      ang: Math.acos(Math.max(-1, Math.min(1,
        c[0] * q[0] + c[1] * q[1] + c[2] * q[2]))),
      from: q, notBefore: 0, key: 0,
    };
  }

  /* Every open, not just the first: the arrival is how the dome says
   * "these are photographs, and each one belongs somewhere". Nothing is
   * queued here — the canvas may not have its size yet — so the first
   * draw queues whatever that view holds. The wide-field backdrop never
   * flies: it is the sky the photographs land on, and the largest fill. */
  function introBegin() {
    introStop();
    if (!shots.length || !motionOK()) return;
    for (const s of shots) s.arrived = !!s.bg;
    animWave = "open";
    animPeakLive = 0; animPeakStarts = 0;
  }

  function introActive() {
    return animLive.size > 0 || animQueue.length > 0 || animWave === "open";
  }

  /* A destination ripples as the camera reaches it: the frame and its
   * nearest neighbours within TAP_RADII of its own size, never more than
   * TAP_MAX, beginning just before touchdown and spreading outward. A tap
   * supersedes whatever was waiting — frames queued to arrive are simply
   * there, and an earlier destination's ripple that had not begun is
   * dropped — so a string of taps cannot stack up animations. */
  function animTap(dest) {
    for (const q of animQueue) { q.anim = null; q.arrived = true; }
    animQueue = [];
    if (!motionOK()) return;
    const c = dest.centre;
    const reach = TAP_RADII * dest.radius;
    const near = [];
    for (const q of shots) {
      if (q.bg || q.anim) continue;            // already moving: leave it be
      const d = Math.acos(Math.max(-1, Math.min(1,
        q.centre[0] * c[0] + q.centre[1] * c[1] + q.centre[2] * c[2])));
      if (d <= reach) near.push([d, q]);
    }
    near.sort((a, b) => a[0] - b[0]);
    const start = performance.now() + FLY_MS * 0.6;
    near.slice(0, TAP_MAX).forEach(([, q], rank) => {
      animAssign(q, "tap", "ripple");
      q.anim.notBefore = start + rank * TAP_STAGGER_MS;
      q.anim.key = -10 + rank;
      q.arrived = true;          // it is there already; it ripples in place
      animQueue.push(q);
    });
  }

  /* One tick of the arrivals, run by draw() once the canvas has its size.
   * Every frame costs one dot product here; only the few that are moving
   * cost a matrix. */
  function animPump(now) {
    const motion = motionOK();
    const { f } = basis();
    const aspect = (canvas.width / canvas.height) || 1;
    const halfBase = Math.atan(Math.tan(cam.fov * DEG / 2) * Math.hypot(1, aspect))
                   * (1 + ANIM_MARGIN);
    const inView = (s) => {
      const h = halfBase + s.radius;
      return h >= Math.PI
        || s.centre[0] * f[0] + s.centre[1] * f[1] + s.centre[2] * f[2] > Math.cos(h);
    };
    // A tap's ripple is queued before the camera gets there, so it is judged
    // against the view only once the flight is over.
    const exempt = (s) => !!flying && s.anim.wave === "tap";

    // 1. Frames seen for the first time. While the camera is flying they are
    //    simply there: a flight crosses the sky, and animating what it passes
    //    is exactly the whole-sky cost this exists to avoid.
    let added = false;
    for (const s of shots) {
      if (s.arrived !== false || s.anim || !inView(s)) continue;
      if (flying || !motion) { s.arrived = true; continue; }
      animAssign(s, animWave === "open" ? "open" : "pan", "arrive");
      // Middle of the view first.
      s.anim.key = -(s.centre[0] * f[0] + s.centre[1] * f[1] + s.centre[2] * f[2]);
      animQueue.push(s);
      added = true;
    }
    if (animWave === "open") animWave = "";

    // 2. Land what is done, and anything that has left the view.
    for (const s of animLive) {
      if (now - s.anim.t0 >= s.anim.dur || (!inView(s) && !exempt(s))) {
        s.anim = null; s.arrived = true; animLive.delete(s);
      }
    }
    if (!animQueue.length) return;
    if (added) animQueue.sort((a, b) => a.anim.key - b.anim.key);

    // 3. A frame that left the view before its turn drops out of the queue:
    //    one not yet arrived comes in when next seen; a ripple never starts.
    animQueue = animQueue.filter((s) => {
      if (inView(s) || exempt(s)) return true;
      s.anim = null;
      return false;
    });

    // 4. Start the next few, within both caps.
    let started = 0;
    for (let i = 0; i < animQueue.length;) {
      if (animLive.size >= ANIM_MAX || started >= ANIM_STARTS_PER_TICK) break;
      const s = animQueue[i];
      if (s.anim.notBefore > now) { i++; continue; }
      animQueue.splice(i, 1);
      s.anim.state = "live";
      s.anim.t0 = now;
      s.arrivals = (s.arrivals || 0) + 1;
      animLive.add(s);
      started++;
    }
    if (started > animPeakStarts) animPeakStarts = started;
    if (animLive.size > animPeakLive) animPeakLive = animLive.size;
  }

  /* How far from home this frame is drawn right now: 1 → 0 for an arrival,
   * 0 → peak → 0 for a ripple. Zero whenever it is not moving, which is
   * what lets the draw path ask unconditionally. */
  function introEase(s, now) {
    const a = s.anim;
    if (!a || a.state !== "live") return 0;
    const p = ((now === undefined ? performance.now() : now) - a.t0) / a.dur;
    if (p >= 1) return 0;
    const q = Math.max(0, p);
    if (a.kind === "ripple") return Math.sin(Math.PI * q) * (1 - q) * RIPPLE_NORM;
    const k = 1 - q;
    return k * k * k;
  }

  /* Where this frame is drawn: still turned away from home by whatever is
   * left of its journey, and still rolling. Exactly the identity once it
   * has landed. */
  function introSpin(s, now) {
    const k = introEase(s, now);
    if (!k) return IDENT3;
    const a = s.anim;
    const travel = a.ang * k;
    const roll = a.rot * k;
    if (!travel && !roll) return IDENT3;
    if (!travel) return rotAbout(s.centre, roll, introSpinBuf);
    const T = rotAbout(a.axis, travel, introTravelBuf);
    if (!roll) return T;
    // Roll first, in the frame's own plane; the journey then carries the
    // turned frame. The other order would swing it round on an arm.
    return mulMat3(T, rotAbout(s.centre, roll, introRollBuf), introSpinBuf);
  }

  /* PURE — the canvas buffer size, in device pixels, from the VIEWPORT. The
   * dome overlay is fixed to the viewport, so the buffer must follow
   * window.innerWidth/Height — never the canvas's client box, which a scaled
   * document.body inflates (the flight zooms body to fill the screen, and a
   * client-box read then produced a buffer ~12x too tall: a black sliver). */
  function domeCanvasSize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    return [Math.floor((window.innerWidth || 0) * dpr),
            Math.floor((window.innerHeight || 0) * dpr)];
  }

  function draw() {
    if (!ready || !opened) return;
    const [W, H] = domeCanvasSize();
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width = W; canvas.height = H;
    }
    gl.viewport(0, 0, W, H);
    gl.clearColor(0.016, 0.020, 0.035, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const VP = viewProj(W / H || 1);

    // Arrivals first: this queues frames that just came into view, starts
    // the next few, and so decides which of them are drawn at all.
    animNow = performance.now();
    animPump(animNow);

    /* What to draw: frames whose real position is on screen and that have
     * arrived, plus the few mid-flight (never more than ANIM_MAX), which
     * may sit just outside that test while they travel home.
     *
     * This used to draw EVERY frame for the whole opening, because each
     * started anywhere on the sphere and might cross the view — 191 draws a
     * tick for 132 on screen. Arrivals now start near home, inside the
     * margin, so the cull holds throughout. A frame queued to arrive and
     * not yet begun is skipped: it has not arrived. Detail loading still
     * asks about real positions, so none of this changes what is fetched.
     */
    const vis = [];
    const bgVis = [];
    for (let i = 0; i < shots.length; i++) {
      const s = shots[i];
      const moving = s.anim && s.anim.state === "live";
      if (!moving && !(s.arrived !== false && onScreen(s))) continue;
      (s.bg ? bgVis : vis).push(i);
    }

    /* TWO passes: the photographs, then the graticule OVER them.
     *
     * It used to be three, and the extra one was a silhouette prepass that
     * painted every footprint black into the depth buffer purely so the
     * graticule could be depth-rejected behind them. That made the grid a
     * backdrop, which is the wrong way round: the coordinate lines are an
     * overlay on the map and a viewer needs to read them ACROSS a frame to
     * tell what they are looking at, not have them stop at its edge.
     *
     * Drawing the grid last removes the reason that pass existed, so it is
     * gone — and with it half the draw calls, since it walked every visible
     * frame a second time with its own uniform and buffer binds.
     *
     * The grid must blend now: over the cleared sky it never mattered that
     * blending was off, because the alpha landed on a flat background. Over
     * a photograph an unblended line would punch an opaque slot through it.
     *
     * This applies to the DOME only. A custom capture calls footprintPass
     * directly into its own framebuffer and never runs draw(), so no
     * coordinate line can reach a saved photograph — which is the whole
     * point of a capture being of the sky rather than of the interface. */
    // 1. Backdrop frames, if any, composited on their own FIRST.
    //
    //    A wide-field survey frame covers hundreds of square degrees at a
    //    few minutes of exposure. Averaged in with a three-hour stack of
    //    one nebula inside it, it hazes that stack over — and the depth
    //    weight cannot rescue it, because depthWeight() is clamped and a
    //    clamped weight still contributes. So the backdrop is composited
    //    first and the photographs are drawn over it.
    //
    //    This works without any change to footprintPass: its composite
    //    already blends SRC_ALPHA/ONE_MINUS_SRC_ALPHA and leaves alpha at
    //    zero where no frame held light, so the second pass covers the
    //    backdrop exactly where it has data and nowhere else.
    if (bgVis.length) {
      footprintPass(VP, bgVis, W, H, FEATHER_UV, null, liveGain() * BG_GAIN);
    }

    // 2. The photographs, accumulated and composited (footprintPass).
    //    The dome feathers its plate edges too. It was left hard on the
    //    grounds that the frames are separate photographs on a map and
    //    should read as such — but a seam is not an edge between
    //    photographs, it is a straight line drawn across a nebula.
    footprintPass(VP, vis, W, H, FEATHER_UV, null, liveGain());

    // 3. Graticule, OVER the photographs. Blended, and with the depth test
    //    off: there is no longer a silhouette in the depth buffer to be
    //    rejected by, and leaving the test on would compare against
    //    whatever the last pass happened to leave there.
    const gpPos = gl.getAttribLocation(gridProg, "aPos");
    const gpCol = gl.getUniformLocation(gridProg, "uColor");
    gl.useProgram(gridProg);
    gl.uniformMatrix4fv(gl.getUniformLocation(gridProg, "uVP"), false, VP);
    gl.enableVertexAttribArray(gpPos);
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindBuffer(gl.ARRAY_BUFFER, gridBuf);
    gl.vertexAttribPointer(gpPos, 3, gl.FLOAT, false, 0, 0);
    gl.uniform4f(gpCol, GRID_RGBA[0], GRID_RGBA[1], GRID_RGBA[2], GRID_RGBA[3]);
    gl.drawArrays(gl.LINES, 0, gridCount);
    for (const c of CIRCLES) {
      if (!c.count) continue;
      gl.uniform4f(gpCol, c.colour[0], c.colour[1], c.colour[2],
                   c.colour[3] * GRID_OVER_ALPHA);
      gl.drawArrays(gl.LINES, c.first, c.count);
    }

    gl.disable(gl.BLEND);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);

    // 4. Frame circles, then reference markers on top of everything.
    // Circles first so a marker ring is never buried under them.
    drawObjectCircles(VP);
    drawMarkers(VP);
    updateMarkerLabels();
    updateObjectLabels();

    // The arrival highlight is DOM over the canvas for the same reason
    // the capture outline below is, and re-projects with it.
    hlUpdateOverlay();

    // The capture outline is DOM over the canvas, so it has to be
    // re-projected whenever the view moves or it would slide off the sky
    // it is supposed to be marking.
    capUpdateOverlay();

    // Keep turning only while something is moving or waiting its turn. A
    // camera flight redraws every display frame itself, so it is not doubled
    // here — the opening used to draw from its own loop AND from schedule().
    if (!flying && introActive()) schedule();
  }

  function schedule() {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; draw(); });
  }

  // ── Custom capture ────────────────────────────────────────────────
  /* Point the dome at a patch of sky and take your own photograph of it.
   *
   * Two taps set opposite corners of a region; the region is then a real
   * gnomonic frame on the sky (centre, basis, half-angles), not a rectangle
   * on the screen — so it stays put when the view is panned or zoomed, and
   * what the blue outline encloses is exactly what the capture renders.
   *
   * The capture goes through footprintPass, the same code the dome draws
   * itself with. That is the whole design: the data-aware coverage, the
   * integration-depth weighting and the divide-once composite already turn
   * overlapping frames into one averaged picture, so a capture is that
   * renderer pointed at a chosen region and read back — not a separate
   * stitcher that would drift from what the viewer was looking at.
   *
   * The one addition is a feathered plate edge (uFeather), because a stitch
   * is judged on its seams in a way a map of separate frames is not. */
  /* Width of the cross-fade at a frame's own border, as a fraction of the
   * plate. Frames are flattened to a common sky level before they are
   * shipped, but they do not arrive identical — different nights, different
   * transparency, different moon — so where two overlap, the step between
   * them shows as a hard straight line across the sky. Reported at the North
   * America Nebula, where two frames meet across the middle of it.
   *
   * The divide-once composite is what makes this safe: coverage is the
   * divisor, so a frame ALONE on its patch of sky is drawn at full strength
   * however far its weight has been ramped down. The fade only takes effect
   * where there is another frame to fade into. */
  // Widened from 0.04 on 2026-09-21. Four per cent of the plate is about
  // 0.09 degrees on a Seestar frame, which hides a small step and does not
  // hide the one cloud makes:
  //
  //     "I hope you can design it to hide the edges of the frames better.
  //      There might be some dithering or fading technique to seamlessly
  //      get rid of those edges that mess up large shots. ... Clouds
  //      really mess it up so we need to ensure this."
  //
  // A frame shot through haze sits on a raised background, and the step
  // where it meets a clear neighbour is proportionally larger than
  // anything the original width was tuned against — that one was set at
  // the North America Nebula, where two CLEAR frames met.
  //
  // Twelve per cent is about 0.26 degrees of cross-fade. Safe to widen
  // because of the divide-once composite: coverage is the divisor, so a
  // frame ALONE on its patch of sky is drawn at full strength however far
  // its weight has been ramped down. The ramp only does anything where
  // there is another frame to fade into.
  //
  // The real fix is upstream and is now in place — light-cloud subs get a
  // per-frame background extraction before they are stacked, so future
  // renders arrive closer to each other. This is what can be done for the
  // frames already published.
  const FEATHER_UV = 0.12;
  const CAP_MAX_SIDE = 8192;       // cap before driver limits are consulted
  /* Total pixels a capture may be. The long-side cap alone is the wrong
   * limit for a wide region: 37 degrees at the album's best sampling is
   * 285 megapixels, and the accumulation target for that is RGBA half float
   * — eight bytes a pixel — before the readback and the encode. 16 MP keeps
   * the whole chain near a quarter of a gigabyte. */
  const CAP_MAX_PIXELS = 16e6;
  const CAP_MIN_SIDE = 320;
  const CAP_LOAD_TIMEOUT_MS = 25000;

  let capOn = false;          // capture mode engaged
  /* Three points, as unit sky vectors.
   *
   * P1 and P2 are the ends of one EDGE: their direction is the rectangle's
   * rotation and their separation is its width. P3 sets the height, as its
   * perpendicular distance from the P1-P2 line.
   *
   * Two points cannot express this. A rectangle on the sky has five degrees
   * of freedom — centre, size, rotation — and two points give four numbers,
   * so something has to be assumed, and every choice of assumption was a
   * reported bug: assume the rectangle is square to the screen and it will
   * not rotate with the points; assume landscape and swap the extents to get
   * it, and a selection drawn with one point above the other stops
   * containing either of them. Three points assume nothing. */
  let capP1 = null;
  let capP2 = null;
  let capP3 = null;
  let capDragHandle = 0;      // 1, 2 or 3 while a handle is being dragged
  let capBusy = false;
  let capFB = null, capTex = null, capW = 0, capH = 0;

  const capEls = {};

  function norm3(v) {
    const n = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / n, v[1] / n, v[2] / n];
  }
  function cross3(a, b) {
    return [a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0]];
  }
  function dot3(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

  /* Sky direction -> client coordinates. The inverse of dirAt, and the
   * reason the outline can be drawn as DOM over the canvas: the corners are
   * projected every frame, so the region is pinned to the sky rather than
   * to the screen. Returns null behind the camera. */
  function screenAt(d) {
    const { f, r, u } = basis();
    const zf = dot3(d, f);
    if (zf <= 1e-6) return null;
    const rect = canvas.getBoundingClientRect();
    const t = Math.tan(cam.fov * DEG / 2);
    const aspect = (rect.width / rect.height) || 1;
    const ndcX = (dot3(d, r) / zf) / (t * aspect);
    const ndcY = (dot3(d, u) / zf) / t;
    return [rect.left + (ndcX * 0.5 + 0.5) * rect.width,
            rect.top + (0.5 - ndcY * 0.5) * rect.height];
  }

  function add3(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
  function mul3(a, k) { return [a[0] * k, a[1] * k, a[2] * k]; }

  /* Three points -> a gnomonic frame on the sky.
   *
   * P1->P2 is one edge: its direction is the rotation, its length the width.
   * P3 sets the height by its perpendicular distance from that edge, and its
   * component ALONG the edge is deliberately ignored — the edge already
   * fixed the rotation, and letting the third point argue with it is how a
   * three-handle rig becomes unpredictable.
   *
   * Everything is done in the tangent (gnomonic) plane at the edge midpoint,
   * where the rectangle really is a rectangle, and only then re-expressed
   * about the region's own centre — which is what the renderer wants and
   * what capVP projects through.
   *
   * The handedness matters and was wrong before: the dome's basis() uses
   * r = f x u, so the region must use u = r x c. Built the other way round
   * the right-vector is negated, and every capture comes out MIRRORED — a
   * defect that is invisible in a star field, which is exactly why it needs
   * to be asserted against the dome's own projection rather than eyeballed
   * (see the harness test "a capture of the current view matches the dome's
   * own projection"). */
  function capRegion() {
    if (!capP1 || !capP2 || !capP3) return null;
    const m = norm3(add3(capP1, capP2));               // edge midpoint
    let r = add3(capP2, mul3(m, -dot3(capP2, m)));     // edge direction at m
    if (Math.hypot(r[0], r[1], r[2]) < 1e-9) return null;
    r = norm3(r);
    const n0 = norm3(cross3(r, m));                    // "up" at m: r x f
    const z3 = dot3(capP3, m);
    const z2 = dot3(capP2, m);
    if (z3 <= 1e-6 || z2 <= 1e-6) return null;
    const eta = dot3(capP3, n0) / z3;                  // height, tan-space
    const hwT = Math.abs(dot3(capP2, r) / z2);         // half width, tan-space
    if (!(hwT > 1e-9) || !isFinite(eta)) return null;

    // The four corners, in the tangent plane at m, then back onto the sphere.
    const corners = [[-hwT, 0], [hwT, 0], [hwT, eta], [-hwT, eta]].map(
      ([x, y]) => norm3(add3(add3(m, mul3(r, x)), mul3(n0, y))));

    const c = norm3(corners.reduce(add3, [0, 0, 0]));
    let rc = add3(r, mul3(c, -dot3(r, c)));
    if (Math.hypot(rc[0], rc[1], rc[2]) < 1e-9) return null;
    rc = norm3(rc);
    const uc = norm3(cross3(rc, c));                   // u = r x c
    let hw = 0, hh = 0;
    for (const q of corners) {
      const z = dot3(q, c);
      if (z <= 1e-6) continue;
      hw = Math.max(hw, Math.abs(Math.atan(dot3(q, rc) / z)));
      hh = Math.max(hh, Math.abs(Math.atan(dot3(q, uc) / z)));
    }
    hw = Math.max(hw, 0.25 * DEG);
    hh = Math.max(hh, 0.25 * DEG);
    // A gnomonic frame cannot reach 90 degrees; keep well inside that.
    hw = Math.min(hw, 62 * DEG);
    hh = Math.min(hh, 62 * DEG);
    return { c, r: rc, u: uc, hw, hh };
  }

  /* Where the third handle is DRAWN: the midpoint of the edge opposite
   * P1-P2. Dragging P3 sideways changes nothing, so showing the handle
   * under the cursor would promise a effect that does not happen; putting
   * it on the perpendicular shows what the drag actually did. */
  function capP3Handle() {
    const reg = capRegion();
    if (!reg) return null;
    const cs = capCorners(reg);          // [-+, ++, +-, --] in r/u signs
    // capCorners emits (-1,+1), (+1,+1), (+1,-1), (-1,-1) in (r, u).
    // The P1-P2 edge is whichever of the two u-extremes P1 sits nearer.
    const topMid = norm3(add3(cs[0], cs[1]));
    const botMid = norm3(add3(cs[2], cs[3]));
    return dot3(capP1, topMid) > dot3(capP1, botMid) ? botMid : topMid;
  }

  function capCorners(reg) {
    const tw = Math.tan(reg.hw), th = Math.tan(reg.hh);
    const out = [];
    for (const [sx, sy] of [[-1, 1], [1, 1], [1, -1], [-1, -1]]) {
      out.push(norm3([
        reg.c[0] + reg.r[0] * sx * tw + reg.u[0] * sy * th,
        reg.c[1] + reg.r[1] * sx * tw + reg.u[1] * sy * th,
        reg.c[2] + reg.r[2] * sx * tw + reg.u[2] * sy * th,
      ]));
    }
    return out;
  }

  /* A point inside the region, addressed the way the PHOTOGRAPH is:
   * u runs 0→1 left to right, v runs 0→1 top to bottom. Built the same way
   * capCorners builds its four, so (0,0) is corner 0 and the guide cannot
   * drift from the outline it is drawn inside.
   *
   * The tangents are the point: the capture is a gnomonic render, so equal
   * steps in `u` are equal steps ACROSS THE FINISHED IMAGE, not equal
   * angles on the sky. A thirds line has to sit a third of the way across
   * the photograph or it is not a thirds line. */
  function capGuidePoint(reg, u, v) {
    const sx = (u * 2 - 1) * Math.tan(reg.hw);
    const sy = (1 - v * 2) * Math.tan(reg.hh);
    return norm3([
      reg.c[0] + reg.r[0] * sx + reg.u[0] * sy,
      reg.c[1] + reg.r[1] * sx + reg.u[1] * sy,
      reg.c[2] + reg.r[2] * sx + reg.u[2] * sy,
    ]);
  }

  /* The guides, as lines in that same (u, v) frame space.
   *
   * Ordered so the cycle goes from the most conventional to the most
   * specialised, and `off` is first so the control returns to a clean sky
   * on the press after the last one.
   *
   * CENTRE is not decoration. The album shipped a photograph titled Lagoon
   * Nebula with the Trifid dead in the middle of it and the Lagoon clipped
   * against the left edge, and nothing on screen while it was being framed
   * would have said so. A cross through the middle is the one guide that
   * answers "is my target actually the subject of this frame". */
  const CAP_PHI = 0.3819660112501051;      // 1/φ² — the short arm of the golden cut
  const CAP_GUIDES = [
    { id: "off", label: "Guide", name: "off", lines: [] },
    { id: "thirds", label: "Thirds", name: "rule of thirds", lines: [
      [[1 / 3, 0], [1 / 3, 1]], [[2 / 3, 0], [2 / 3, 1]],
      [[0, 1 / 3], [1, 1 / 3]], [[0, 2 / 3], [1, 2 / 3]],
    ] },
    { id: "golden", label: "Golden", name: "golden ratio", lines: [
      [[CAP_PHI, 0], [CAP_PHI, 1]], [[1 - CAP_PHI, 0], [1 - CAP_PHI, 1]],
      [[0, CAP_PHI], [1, CAP_PHI]], [[0, 1 - CAP_PHI], [1, 1 - CAP_PHI]],
    ] },
    { id: "diagonals", label: "Diagonals", name: "diagonals", lines: [
      [[0, 0], [1, 1]], [[1, 0], [0, 1]],
    ] },
    { id: "centre", label: "Centre", name: "centre cross", lines: [
      [[0.5, 0], [0.5, 1]], [[0, 0.5], [1, 0.5]],
    ] },
  ];
  /* Samples along each guide line. A line that is straight in the finished
   * photograph is a curve on the dome, and how much of one depends on how
   * wide the region is and how far from the view centre it sits. 24 is
   * where a 37-degree region — the widest the capture allows — stops
   * showing corners between the segments. */
  const CAP_GUIDE_STEPS = 24;
  let capGuideIx = 0;

  function capVP(reg) {
    const { c: f, r, u } = reg;
    const V = [
      r[0], u[0], -f[0], 0,
      r[1], u[1], -f[1], 0,
      r[2], u[2], -f[2], 0,
      0, 0, 0, 1,
    ];
    const near = 0.01, far = 10;
    const P = [
      1 / Math.tan(reg.hw), 0, 0, 0,
      0, 1 / Math.tan(reg.hh), 0, 0,
      0, 0, (far + near) / (near - far), -1,
      0, 0, 2 * far * near / (near - far), 0,
    ];
    const o = new Float32Array(16);
    for (let cI = 0; cI < 4; cI++) {
      for (let rI = 0; rI < 4; rI++) {
        let acc = 0;
        for (let k = 0; k < 4; k++) acc += P[k * 4 + rI] * V[cI * 4 + k];
        o[cI * 4 + rI] = acc;
      }
    }
    return o;
  }

  /* Do a frame and the region actually overlap?
   *
   * Both are convex quadrilaterals bounded by great circles, and a gnomonic
   * projection carries a great circle to a straight line — so seen from the
   * region's own tangent plane the pair is two convex polygons in 2D, and
   * the separating-axis test settles it exactly. The region projects to the
   * axis-aligned rectangle the projection is built around; the frame lands
   * wherever its four corners land.
   *
   * This is the case the corner tests cannot see. Two rectangles can overlap
   * with no corner of either inside the other — one crosses the other like
   * the bars of a plus sign — and that is not an exotic shape here, it is
   * what a 3.9 deg frame does to a 4.5 deg-tall strip every single time.
   *
   * A corner on or behind the tangent plane's horizon cannot be projected,
   * and returns true: over-inclusion costs one texture fetch, under-
   * inclusion costs the picture. */
  function capQuadOverlap(reg, corners) {
    const tw = Math.tan(reg.hw), th = Math.tan(reg.hh);
    const F = [];
    for (const d of corners) {
      const z = dot3(d, reg.c);
      if (z <= 1e-6) return true;
      F.push([dot3(d, reg.r) / z, dot3(d, reg.u) / z]);
    }
    const R = [[-tw, -th], [tw, -th], [tw, th], [-tw, th]];
    // A separating axis is one on which the two shadows do not meet. Test
    // the edge normals of both shapes; if none separates them, they overlap.
    const axes = [[1, 0], [0, 1]];
    for (let i = 0; i < F.length; i++) {
      const p = F[i], q = F[(i + 1) % F.length];
      axes.push([p[1] - q[1], q[0] - p[0]]);
    }
    for (const [ax, ay] of axes) {
      let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
      for (const p of R) {
        const t = p[0] * ax + p[1] * ay;
        if (t < a0) a0 = t;
        if (t > a1) a1 = t;
      }
      for (const p of F) {
        const t = p[0] * ax + p[1] * ay;
        if (t < b0) b0 = t;
        if (t > b1) b1 = t;
      }
      if (a1 < b0 || b1 < a0) return false;
    }
    return true;
  }

  /* Frames that can contribute to the region.
   *
   * A cone test first — cheap, and over-inclusive. Then an exact pass: a
   * frame's corner inside the region, or a region corner inside the frame,
   * or — the case those two miss — their edges crossing with no corner of
   * either inside the other, which capQuadOverlap decides.
   *
   * ONE list comes back, under one name, because the two that used to come
   * back cost a capture its sharpness. The cone list was DRAWN and the
   * exact list was GATHERED, so a frame the corner tests
   * missed was composited from whatever texture it happened to be holding —
   * for a frame nobody had zoomed into, tier 0 — while the tier loader and
   * the embedded frame list, which both read the exact list, never knew it
   * was there. It was not a subtle fault either. On a 14.2 x 4.5 deg
   * capture of Sagittarius it caught the M 24 mosaic: 256 px over 7.8 deg
   * is 33 px/deg, magnified fifteen times into a 498 px/deg output, and at
   * 1010 s over rich sky that frame carried the heaviest depth weight for
   * two degrees around — so it won the blend everywhere it reached and
   * painted a soft rectangle across the middle of an otherwise sharp
   * picture, with nothing in the capture's own frame list to name it.
   * Whatever is drawn must be exactly what was prepared and exactly what
   * is reported. */
  function capFramesIn(reg) {
    const half = Math.atan(Math.hypot(Math.tan(reg.hw), Math.tan(reg.hh)));
    const near = [];
    for (let i = 0; i < shots.length; i++) {
      const s = shots[i];
      if (dot3(s.centre, reg.c) > Math.cos(Math.min(Math.PI, half + s.radius))) {
        near.push(i);
      }
    }
    const tw = Math.tan(reg.hw), th = Math.tan(reg.hh);
    const inRegion = (d) => {
      const z = dot3(d, reg.c);
      return z > 1e-6
        && Math.abs(dot3(d, reg.r) / z) <= tw
        && Math.abs(dot3(d, reg.u) / z) <= th;
    };
    const corners = capCorners(reg);
    const hit = [];
    for (const i of near) {
      const s = shots[i];
      let touches = s.corners ? s.corners.some(inRegion) : false;
      if (!touches) {
        for (const d of corners) {
          const dec = Math.asin(Math.max(-1, Math.min(1, d[2])));
          const ra = Math.atan2(d[1], d[0]);
          const px = skyToPix(ra, dec, s.wcs);
          if (px && px[0] >= 0 && px[0] <= s.wcs.image_size[0]
                 && px[1] >= 0 && px[1] <= s.wcs.image_size[1]) {
            touches = true; break;
          }
        }
      }
      if (!touches && s.corners) touches = capQuadOverlap(reg, s.corners);
      if (touches) hit.push(i);
    }
    return { gathered: hit };
  }

  function capEnsureTarget(W, H) {
    if (capFB && capW === W && capH === H) return true;
    if (capTex) gl.deleteTexture(capTex);
    if (capFB) gl.deleteFramebuffer(capFB);
    capTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, capTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, W, H, 0, gl.RGBA,
                  gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    capFB = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, capFB);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0,
                            gl.TEXTURE_2D, capTex, 0);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    capW = W; capH = H;
    return ok;
  }

  /* Output size: enough pixels to carry the sharpest texture that actually
   * covers the region, and no more. Sampling past that invents nothing and
   * costs memory quadratically.
   *
   * Bounded three ways — the long side, the total pixel count, and whatever
   * the driver will allocate — because a wide region asks for far more than
   * any of them. What it returns is therefore usually a DOWNSAMPLE of the
   * source, which is fine and sharp; the thing that must not happen is the
   * opposite, and that is what capTierFor exists to prevent. */
  function capOutputSize(reg, idx) {
    const wDeg = 2 * reg.hw / DEG, hDeg = 2 * reg.hh / DEG;
    let best = 0;
    for (const i of idx) {
      const s = shots[i];
      best = Math.max(best, s.levels[s.maxLevel].px / s.degLong);
    }
    if (!best) best = 200;
    let maxSide = CAP_MAX_SIDE;
    try {
      const lim = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 0;
      if (lim) maxSide = Math.min(maxSide, lim);
      const rb = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) || 0;
      if (rb) maxSide = Math.min(maxSide, rb);
    } catch (_) { /* stub context — keep the default */ }
    let W = wDeg * best, H = hDeg * best;
    let scale = Math.min(1, maxSide / Math.max(W, H, 1));
    const px = (W * scale) * (H * scale);
    if (px > CAP_MAX_PIXELS) scale *= Math.sqrt(CAP_MAX_PIXELS / px);
    W = Math.max(CAP_MIN_SIDE, Math.round(W * scale));
    H = Math.max(CAP_MIN_SIDE, Math.round(H * scale));
    return [W, H, best];
  }

  /* The tier a frame needs to fill the OUTPUT at one texture pixel per
   * output pixel — the same rule wantedLevelAt() uses for the screen.
   *
   * The capture used to ask every frame for its sharpest tier regardless.
   * That is not "highest quality", it is a way of losing quality: 24 frames
   * at tier 2 is about 200 MB against a 160 MB browsing budget, so evict()
   * dropped whatever it had to back to TIER 0 — 256 px over four degrees,
   * against an output asking for far more. The result was magnified rather
   * than downsampled, which is exactly the blur that shows up when a
   * capture is taken zoomed out. */
  function capTierFor(s, outPxPerDeg) {
    const need = outPxPerDeg * s.degLong;
    for (let i = 0; i < s.levels.length; i++) {
      if (s.levels[i].px >= need) return Math.min(i, s.maxLevel);
    }
    return s.maxLevel;
  }

  /* Roughly what a tier costs once uploaded. The tiers are 1:2, and
   * `px` is the long side, so the area is px * px/2 at 4 bytes. */
  function capTierBytes(s, level) {
    const px = s.levels[Math.min(level, s.maxLevel)].px;
    return px * (px / 2) * 4;
  }

  /* Pull the sharpest tier for everything in the region and wait.
   *
   * The dome loads detail for what is on SCREEN, at the tier the current
   * zoom justifies. A capture is rendered at its own, higher resolution, so
   * without this it would be stitched out of whatever tiers the viewer's
   * last position happened to leave loaded — sharp in the middle, soft at
   * the edges, for no reason the viewer could see. */
  function capLoadDetail(idx, outPxPerDeg) {
    // Lift the eviction budget to cover exactly this capture, so the tiers
    // that have just been fetched are not thrown away again while the rest
    // are still arriving. Restored in capSnap's finally.
    let need = 0;
    for (const i of idx) need += capTierBytes(shots[i], capTierFor(shots[i], outPxPerDeg));
    DETAIL_BUDGET = Math.min(DETAIL_BUDGET_CAPTURE_MAX,
                             Math.max(DETAIL_BUDGET_BROWSE, Math.ceil(need * 1.25)));
    for (const i of idx) {
      const s = shots[i];
      // Tier 0 first, and explicitly. It is loaded for every frame when the
      // dome opens, but "when the dome opens" is a race a capture can lose:
      // a frame with no texture at all does not fail visibly, it renders as
      // the flat placeholder plate, and the capture would come back as a
      // smooth grey rectangle that looks like a processing choice rather
      // than missing data. Waiting on `inflight` alone does not cover this,
      // because loadBase does not touch that counter.
      loadBase(s);
      const want = capTierFor(s, outPxPerDeg);
      if (want > s.detailLevel) loadDetail(s, want);
    }
    const t0 = Date.now();
    // Every frame must be at the tier the OUTPUT needs, not merely have some
    // texture — "it has a picture" was satisfied by tier 0 and is what let a
    // blurry capture report itself complete.
    const shortOf = (i) => {
      const s = shots[i];
      return s.detailLevel < capTierFor(s, outPxPerDeg)
          && s.detailLevel < s.maxLevel;
    };
    const stillLoading = () => idx.filter(shortOf);
    const atAlbumLimit = () => idx.filter((i) => {
      const s = shots[i];
      return s.detailLevel >= s.maxLevel
          && s.maxLevel < capTierFor(s, outPxPerDeg);
    });

    /* Wait for the tiers the OUTPUT needs, and ask again before giving up.
     *
     * This used to resolve on the timeout and let the capture proceed with
     * whatever had arrived, which is where the intermittent sharpening came
     * from: which frames won the race depended on what the dome happened to
     * have cached from wherever the viewer had last been looking, so the
     * same region captured twice came back sharp in different places.
     *
     * A frame already at maxLevel is NOT short — nothing finer exists, and
     * waiting for it would be waiting for something that is not coming.
     */
    const waitFor = (ms) => new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        if (inflight <= 0 && !stillLoading().length) { resolve(true); return; }
        if (Date.now() - start > ms) { resolve(false); return; }
        setTimeout(tick, 120);
      };
      tick();
    });

    return (async () => {
      let ok = await waitFor(CAP_LOAD_TIMEOUT_MS);
      if (!ok) {
        // Ask again for exactly what is missing. A tier can be dropped by
        // evict() while its siblings are still arriving, and the first
        // request is then simply gone — nothing would ever re-order it.
        const missing = stillLoading();
        for (const i of missing) {
          const s = shots[i];
          loadDetail(s, capTierFor(s, outPxPerDeg));
        }
        ok = await waitFor(CAP_LOAD_TIMEOUT_MS);
      }
      return { complete: ok,
               stillLoading: stillLoading().length,
               atAlbumLimit: atAlbumLimit().length };
    })();
  }

  function capFileName(reg) {
    const dec = Math.asin(Math.max(-1, Math.min(1, reg.c[2]))) / DEG;
    let ra = Math.atan2(reg.c[1], reg.c[0]) / DEG;
    if (ra < 0) ra += 360;
    const h = ra / 15;
    const sign = dec >= 0 ? "+" : "-";
    return `sky_${String(Math.floor(h)).padStart(2, "0")}h`
      + `${String(Math.round((h % 1) * 60)).padStart(2, "0")}m`
      + `${sign}${String(Math.round(Math.abs(dec))).padStart(2, "0")}`
      + `_${(2 * reg.hw / DEG).toFixed(1)}x${(2 * reg.hh / DEG).toFixed(1)}deg.jpg`;
  }

  /* Everything needed to say EXACTLY what a capture is looking at.
   *
   * The filename rounds RA to the minute and Dec to the degree, which names a
   * capture but cannot reproduce one — and it says nothing at all about which
   * photographs went into it. When a capture is used to report a fault ("there
   * is a grey rectangle here"), the first question is always WHICH FRAME that
   * is, and answering it meant guessing from screen position.
   *
   * So the exact region goes into the file itself: centre, basis and
   * half-angles are the five numbers capRegion() works in, and together they
   * pin the view down to the float. The contributing frames go with it, each
   * with the texture tier it was actually drawn from, because "this looked
   * soft" and "this was drawn from tier 1 of 3" are the same report. */
  function capMetaJSON(reg, gathered, shots, crop, W, H, outPxPerDeg) {
    const dec = Math.asin(Math.max(-1, Math.min(1, reg.c[2]))) / DEG;
    let ra = Math.atan2(reg.c[1], reg.c[0]) / DEG;
    if (ra < 0) ra += 360;
    return JSON.stringify({
      what: "astrophotography_public sky-dome capture",
      centreRaDeg: +ra.toFixed(6),
      centreDecDeg: +dec.toFixed(6),
      widthDeg: +(2 * reg.hw / DEG).toFixed(6),
      heightDeg: +(2 * reg.hh / DEG).toFixed(6),
      // The region as the renderer holds it. Unit vectors; c is the look
      // direction, r and u span the tangent plane and carry the roll, which
      // no RA/Dec pair can express on its own.
      region: {
        c: Array.from(reg.c, (v) => +v.toFixed(9)),
        r: Array.from(reg.r, (v) => +v.toFixed(9)),
        u: Array.from(reg.u, (v) => +v.toFixed(9)),
        hwRad: +reg.hw.toFixed(9),
        hhRad: +reg.hh.toFixed(9),
      },
      pixels: { w: crop.w, h: crop.h, renderedW: W, renderedH: H },
      pxPerDeg: Math.round(outPxPerDeg),
      frames: gathered.map((i) => ({
        path: shots[i].path,
        label: shots[i].label || shots[i].objId || null,
        tier: shots[i].detailTex ? shots[i].detailLevel : 0,
        maxTier: shots[i].maxLevel,
      })),
    });
  }

  /* Put a string into a JPEG as a COM segment, right after SOI.
   *
   * COM is ignored by every decoder, so the picture is untouched and the file
   * stays an ordinary JPEG — but `python -c "..."` can read it back, which is
   * the point: a capture that reports a fault should carry the coordinates of
   * the fault. Chosen over EXIF because a comment is a length and some bytes,
   * with no IFD to build and nothing that can be malformed. */
  function jpegWithComment(buf, text) {
    const bytes = new Uint8Array(buf);
    if (bytes.length < 2 || bytes[0] !== 0xFF || bytes[1] !== 0xD8) return null;
    const payload = new TextEncoder().encode(text);
    // The 2-byte length counts itself; the segment cannot exceed 65535.
    if (payload.length + 2 > 0xFFFF) return null;
    const seg = new Uint8Array(4 + payload.length);
    seg[0] = 0xFF; seg[1] = 0xFE;
    seg[2] = ((payload.length + 2) >> 8) & 0xFF;
    seg[3] = (payload.length + 2) & 0xFF;
    seg.set(payload, 4);
    const out = new Uint8Array(bytes.length + seg.length);
    out.set(bytes.subarray(0, 2), 0);
    out.set(seg, 2);
    out.set(bytes.subarray(2), 2 + seg.length);
    return out;
  }

  /* Trim the uncovered margin.
   *
   * A region drawn by hand rarely lands exactly on the imagery, so the
   * render comes back with bands of never-photographed sky down its sides.
   * Alpha is coverage, so those bands are exactly the fully-transparent
   * rows and columns at the edges — walk in from each side while the whole
   * line is empty and stop at the first that holds anything.
   *
   * Only the OUTER margin. A hole in the middle is real: it is sky the
   * telescope has not visited, and cropping to avoid it would silently
   * throw away the photographs around it. */
  function capCropBounds(px, W, H) {
    const covered = (x, y) => px[(y * W + x) * 4 + 3] > 0;
    let x0 = 0, x1 = W - 1, y0 = 0, y1 = H - 1;
    const colEmpty = (x) => { for (let y = y0; y <= y1; y++) if (covered(x, y)) return false; return true; };
    const rowEmpty = (y) => { for (let x = x0; x <= x1; x++) if (covered(x, y)) return false; return true; };
    while (x0 < x1 && colEmpty(x0)) x0++;
    while (x1 > x0 && colEmpty(x1)) x1--;
    while (y0 < y1 && rowEmpty(y0)) y0++;
    while (y1 > y0 && rowEmpty(y1)) y1--;
    return { x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }

  /* A brightness stretch was tried here on 2026-08-21 and rejected.
   *
   * The dome's textures are built to be looked at ON the dome — dark sky
   * against a black sphere — and measure about 17/255 mean, so a capture
   * downloaded as a standalone photograph looks underexposed. A levels
   * adjustment read off the image's own covered pixels fixed the level
   * (mean 17 -> 38 and 85 on the two test regions, 0.2% clipped) and
   * ruined the picture: those tiles are JPEG, compressed hard at a low
   * level, and roughly 10x of gain turned their 8x8 DCT blocks into a
   * visible patchwork over the whole frame. Colour blotching with it.
   *
   * So the capture ships faithful to the dome. Brightening it honestly
   * needs brighter SOURCE tiers, not a stretch at the end — the gain has
   * to be applied before the data is quantised, not after. */

  async function capSnap() {
    const reg = capRegion();
    if (!reg || capBusy) return;
    const { gathered } = capFramesIn(reg);
    if (!gathered.length) {
      capStatus("No photographs cover that region — move or widen it.", true);
      return;
    }
    capBusy = true;
    capUpdateUI();
    try {
      // Size first: the output resolution decides which tier each frame
      // needs, so it cannot be chosen after the textures are already loaded.
      const [W, H, bestPxDeg] = capOutputSize(reg, gathered);
      const outPxPerDeg = W / (2 * reg.hw / DEG);
      capStatus(`Gathering ${gathered.length} frame`
                + `${gathered.length === 1 ? "" : "s"}…`);
      const load = await capLoadDetail(gathered, outPxPerDeg);
      if (!load.complete && load.stillLoading > 0) {
        // Refuse rather than write a file whose sharpness records which
        // textures happened to win a race. The album HAS the detail for
        // these frames; a capture that leaves it out is not a smaller
        // picture, it is a wrong one.
        throw new Error(
          `${load.stillLoading} of ${gathered.length} frames could not load `
          + `the detail this size needs. Nothing has been saved — try again, `
          + `or capture a smaller region.`);
      }
      const complete = load.complete;
      capStatus(`Rendering ${W} × ${H}…`);
      if (!capEnsureTarget(W, H)) throw new Error("capture target unavailable");
      gl.bindFramebuffer(gl.FRAMEBUFFER, capFB);
      gl.viewport(0, 0, W, H);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      const ok = footprintPass(capVP(reg), gathered, W, H,
                               FEATHER_UV, capFB, 1);
      if (!ok) throw new Error("this browser cannot composite a capture");
      const px = new Uint8Array(W * H * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, capFB);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);

      // How much of the requested region actually holds photographs. Shown
      // on the card, because "you asked for this much sky and this is how
      // much of it has been observed" is the honest caption for a capture
      // of a region a viewer drew by hand.
      let covered = 0;
      for (let i = 3; i < px.length; i += 4) if (px[i] > 0) covered++;
      const crop = capCropBounds(px, W, H);
      const out = document.createElement("canvas");
      out.width = crop.w; out.height = crop.h;
      const ctx = out.getContext("2d");
      const img = ctx.createImageData(crop.w, crop.h);
      // GL reads bottom-up; images are top-down. Copy the cropped window
      // straight into the destination, flipping as we go.
      for (let y = 0; y < crop.h; y++) {
        const src = ((H - 1 - (crop.y0 + y)) * W + crop.x0) * 4;
        img.data.set(px.subarray(src, src + crop.w * 4), y * crop.w * 4);
      }
      // Alpha is coverage. Flatten onto black rather than shipping a
      // transparent JPEG, which would come out white.
      for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
      ctx.putImageData(img, 0, 0);

      let blob = await new Promise((res) =>
        out.toBlob(res, "image/jpeg", 0.92));
      if (!blob) throw new Error("the browser would not encode the image");

      // Stamp the exact region and the frame list into the file. Best effort
      // by design: if anything here fails the capture still ships, just
      // without its provenance — losing the picture to save the note would be
      // the wrong trade.
      try {
        const meta = capMetaJSON(reg, gathered, shots, crop, W, H, outPxPerDeg);
        const stamped = jpegWithComment(await blob.arrayBuffer(), meta);
        if (stamped) blob = new Blob([stamped], { type: "image/jpeg" });
      } catch (err) {
        console.warn("[dome] capture metadata not embedded:", err);
      }

      const bare = gathered.filter((i) => !shots[i].detailTex && !shots[i].baseTex);
      const rec = {
        id: `cap${++capSeq}`,
        name: capFileName(reg),
        blob,
        // One image, shown and downloaded. There was a second 720 px copy
        // here for the card, and the album ended up displaying THAT in the
        // big frame at the top — a preview of a capture the viewer had just
        // taken at 5000 px, softened for no reason. The blob is already in
        // memory; the browser can scale it down for a card far better than
        // a re-encode can.
        url: URL.createObjectURL(blob),
        w: crop.w, h: crop.h,
        frames: gathered.length,
        labels: gathered.map((i) => shots[i].label || shots[i].objId)
                        .filter(Boolean),
        wDeg: 2 * reg.hw / DEG * (crop.w / W),
        hDeg: 2 * reg.hh / DEG * (crop.h / H),
        rawW: W, rawH: H,
        coveredPct: 100 * covered / Math.max(1, W * H),
        // What the capture actually resolves, against the best the album
        // holds for this sky. Equal means nothing was given up; lower means
        // the region was too wide to deliver at full sampling, which is a
        // limit of the output size and not of the source.
        pxPerDeg: Math.round(outPxPerDeg),
        bestPxPerDeg: Math.round(bestPxDeg),
        /* Which tier each gathered frame was actually rendered from, against
         * the sharpest it has. Recorded because this is the thing that goes
         * wrong silently: the output can be the right size, every frame can
         * have a texture, and the picture can still be soft because those
         * textures are four steps down the ladder. */
        tiers: gathered.map((i) => [shots[i].detailTex ? shots[i].detailLevel : 0,
                                    shots[i].maxLevel]),
        half: accHalf,
        region: reg,
        partial: load.atAlbumLimit > 0 || bare.length > 0,
        bare: bare.length,
      };
      capKeep(rec);
      // Close BEFORE announcing it. The album opens the capture in the big
      // frame at the top of the main screen, and doing that behind a
      // full-screen dome overlay is the same as not doing it — which is
      // how this read when the capture only ever became a card further
      // down the page.
      close();
      document.dispatchEvent(new CustomEvent("skydome:capture", { detail: rec }));
      capStatus(`Captured ${crop.w} × ${crop.h} from ${gathered.length} frame`
                + `${gathered.length === 1 ? "" : "s"}`
                + (load.atAlbumLimit
                     ? ` (${load.atAlbumLimit} at the finest detail the album `
                       + `holds)`
                     : ""));
    } catch (e) {
      capStatus(`Capture failed: ${(e && e.message) || e}`, true);
    } finally {
      // Hand the memory back and let the browsing budget apply again.
      DETAIL_BUDGET = DETAIL_BUDGET_BROWSE;
      evict(null);
      capBusy = false;
      // A finished capture closes the dome while capBusy is still set, so
      // close() had to leave the textures alone. Release them now.
      if (!opened) releaseAllDetail();
      capUpdateUI();
      draw();
    }
  }

  /* Captures are held in memory as encoded blobs so the download is
   * instant and cannot disagree with the preview beside it. That is a few
   * MB each, so the list is bounded and the oldest object URL is revoked
   * rather than leaked. */
  const CAP_KEEP = 8;
  let capSeq = 0;
  const capMade = [];
  function capKeep(rec) {
    capMade.push(rec);
    while (capMade.length > CAP_KEEP) {
      const old = capMade.shift();
      try { URL.revokeObjectURL(old.url); } catch (_) {}
      document.dispatchEvent(new CustomEvent("skydome:capture-dropped",
                                             { detail: { id: old.id } }));
    }
  }

  function capStatus(text, bad) {
    const el = capEls.status;
    if (!el) return;
    el.textContent = text || "";
    el.classList.toggle("is-bad", !!bad);
  }

  /* The blue outline, drawn as DOM over the canvas and re-projected on
   * every frame so it stays pinned to the sky.
   *
   * Visibility is toggled through style.display, NOT the `hidden` property.
   * `hidden` is defined on HTMLElement and this is an <svg>, so assigning it
   * only created a dead JavaScript property: the overlay was permanently on
   * screen, showing an empty polygon and two handles parked at the origin,
   * and Clear appeared to do nothing. One line, two reported faults, and
   * invisible to tests that only check geometry — so there is now a harness
   * assertion on the displayed state as well. */
  function capShowOverlay(on) {
    const svg = capEls.svg;
    if (!svg) return;
    svg.style.display = on ? "" : "none";
    if (on) svg.removeAttribute("hidden"); else svg.setAttribute("hidden", "");
  }

  function capUpdateOverlay() {
    const svg = capEls.svg;
    if (!svg) return;
    const reg = capOn ? capRegion() : null;
    capShowOverlay(!!reg);
    if (!reg) return;
    const rect = canvas.getBoundingClientRect();
    svg.setAttribute("viewBox", `0 0 ${rect.width} ${rect.height}`);
    const local = (pt) => [pt[0] - rect.left, pt[1] - rect.top];
    const pts = capCorners(reg).map(screenAt);
    const poly = capEls.poly;
    if (poly) {
      if (pts.some((q) => !q)) {
        // Part of the region is behind the camera; the outline would fold
        // inside out, so say nothing rather than draw a lie.
        poly.setAttribute("points", "");
      } else {
        poly.setAttribute("points", pts.map(local)
          .map((q) => `${q[0].toFixed(1)},${q[1].toFixed(1)}`).join(" "));
      }
    }
    capUpdateGuide(reg, local);
    const handles = [[capEls.hA, capP1], [capEls.hB, capP2],
                     [capEls.hC, capP3Handle()]];
    for (const [el, v] of handles) {
      if (!el) continue;
      const q = v && screenAt(v);
      if (!q) { el.setAttribute("r", "0"); continue; }
      const xy = local(q);
      el.setAttribute("r", "9");
      el.setAttribute("cx", xy[0].toFixed(1));
      el.setAttribute("cy", xy[1].toFixed(1));
    }
  }

  /* Draw the selected guide inside the outline.
   *
   * Runs on every frame the outline does, so the <polyline> elements are
   * kept and rewritten rather than rebuilt: this is a drag path, and
   * replacing four nodes per frame is the kind of thing that shows up as
   * the rectangle lagging the finger.
   *
   * A line with any sample behind the camera is dropped whole, for the same
   * reason the polygon is: half a guide line is a wrong guide line, and the
   * outline it belongs to has already gone blank by then anyway. */
  function capUpdateGuide(reg, local) {
    const g = capEls.guide;
    if (!g) return;
    const lines = (CAP_GUIDES[capGuideIx] || CAP_GUIDES[0]).lines;
    while (g.childNodes.length < lines.length) {
      g.appendChild(document.createElementNS(
        "http://www.w3.org/2000/svg", "polyline"));
    }
    const kids = g.childNodes;
    for (let i = 0; i < kids.length; i++) {
      const el = kids[i];
      const ln = lines[i];
      if (!ln) { el.setAttribute("points", ""); continue; }
      const [[u0, v0], [u1, v1]] = ln;
      const pts = [];
      let ok = true;
      for (let s = 0; s <= CAP_GUIDE_STEPS && ok; s++) {
        const t = s / CAP_GUIDE_STEPS;
        const q = screenAt(capGuidePoint(reg, u0 + (u1 - u0) * t,
                                              v0 + (v1 - v0) * t));
        if (!q) { ok = false; break; }
        const xy = local(q);
        pts.push(`${xy[0].toFixed(1)},${xy[1].toFixed(1)}`);
      }
      el.setAttribute("points", ok ? pts.join(" ") : "");
    }
  }

  /* Advance the guide one step and repaint. Wraps back to `off`, so the
   * control is a loop rather than a dead end you have to walk back. */
  function capCycleGuide() {
    capGuideIx = (capGuideIx + 1) % CAP_GUIDES.length;
    capUpdateUI();
    capUpdateOverlay();
  }

  function capUpdateUI() {
    const reg = capRegion();
    if (capEls.panel) capEls.panel.hidden = !capOn;
    if (capEls.toggle) {
      capEls.toggle.classList.toggle("is-on", capOn);
      capEls.toggle.setAttribute("aria-pressed", capOn ? "true" : "false");
      // The button says what pressing it will DO, not what mode you are in —
      // with Snap shot and Clear sitting under it, a label naming the state
      // reads as a third action.
      capEls.toggle.textContent = capOn ? "Exit Mode" : "Capture Mode";
      const t = capOn ? "Leave custom capture"
                      : "Custom capture — frame your own photograph";
      capEls.toggle.title = t;
      capEls.toggle.setAttribute("aria-label", t);
    }
    // The size and frame count used to be printed beside the buttons. They
    // are on the Snap shot button's tooltip now: the readout was more text
    // over the sky, and computing the count meant walking every frame on
    // each pointer move.
    if (capEls.snap) {
      capEls.snap.disabled = !reg || capBusy;
      capEls.snap.title = reg
        ? `Snap shot — ${(2 * reg.hw / DEG).toFixed(2)}° × `
          + `${(2 * reg.hh / DEG).toFixed(2)}°`
        : "Snap shot";
    }
    if (capEls.clear) capEls.clear.disabled = !capP1 || capBusy;
    // This one DOES name its state, unlike the mode toggle above. A toggle
    // has two positions and the label can afford to describe the press; a
    // five-way cycle cannot, and "Guide" on its own leaves the reader to
    // work out which of five they are looking at. The tooltip carries what
    // pressing it will do next, which is the part the label gives up.
    if (capEls.guideBtn) {
      const g = CAP_GUIDES[capGuideIx] || CAP_GUIDES[0];
      const next = CAP_GUIDES[(capGuideIx + 1) % CAP_GUIDES.length];
      capEls.guideBtn.textContent = g.label;
      capEls.guideBtn.classList.toggle("is-on", g.id !== "off");
      const t = `Composition guide — ${g.name}; press for ${next.name}`;
      capEls.guideBtn.title = t;
      capEls.guideBtn.setAttribute("aria-label", t);
    }
    // The column just changed height if a status line appeared or cleared;
    // an open popover has to follow it down rather than end up over it.
    capPlaceHelp();
    capUpdateOverlay();
  }

  /* A rectangle to start from, centred in the current view.
   *
   * Capture mode used to begin with nothing on screen and wait for a drag,
   * which left the viewer looking at an unchanged sky wondering whether the
   * button had worked. Landing a real rectangle with its three handles on it
   * says what the tool is and what can be dragged, in one glance. */
  function capDefaultRegion() {
    const rect = canvas.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const w = Math.max(80, rect.width * 0.34);
    const h = w * 2 / 3;                       // 3:2, landscape
    capP1 = dirAt(cx - w / 2, cy + h / 2);     // bottom-left
    capP2 = dirAt(cx + w / 2, cy + h / 2);     // bottom-right
    capP3 = dirAt(cx, cy - h / 2);             // top edge midpoint
  }

  /* The demonstration clip.
   *
   * A short screen recording of the feature being used, played muted and
   * looping — which is what a GIF would be, at a fraction of the bytes and
   * without the colour banding. `preload="none"` and a src assigned on first
   * open mean a viewer who never presses (?) never downloads it.
   *
   * If the clip is missing the button still works and the written
   * instructions still show; the video element hides itself rather than
   * leaving a broken frame. */
  const CAP_HELP_CLIP = "help/custom-capture.mp4";

  /* Drop the help popover BELOW the button column instead of on top of it.
   *
   * Both hang off .dome-cap-wrap at `top: calc(100% + 8px); right: 0`, and
   * the popover carries the higher z-index — so pressing (?) covered Snap
   * shot, Clear and the (?) itself with a 640px-wide video. In capture mode
   * the one control that must stay in sight is the one that takes the
   * picture, and "how does this work" was hiding exactly that.
   *
   * Measured rather than declared, because the column's height is not
   * fixed: the status line inside it appears, disappears and wraps. */
  function capPlaceHelp() {
    const box = capEls.help, col = capEls.panel;
    if (!box || box.hidden) return;
    if (col && !col.hidden) {
      box.style.top = (col.offsetTop + col.offsetHeight + 8) + "px";
    } else {
      box.style.top = "";     // back to the stylesheet's position
    }
  }

  function capShowHelp(on) {
    const box = capEls.help, vid = capEls.helpVideo;
    if (!box) return;
    box.hidden = !on;
    capPlaceHelp();
    if (capEls.helpBtn) {
      capEls.helpBtn.setAttribute("aria-expanded", on ? "true" : "false");
      capEls.helpBtn.classList.toggle("is-on", !!on);
    }
    if (!vid) return;
    if (on) {
      if (!vid.getAttribute("src")) {
        vid.addEventListener("error", () => { vid.hidden = true; }, { once: true });
        vid.src = CAP_HELP_CLIP + "?v=" + (window.BUILD_STAMP || "1");
      }
      const play = vid.play();
      if (play && play.catch) play.catch(() => { /* autoplay refused */ });
    } else {
      try { vid.pause(); } catch (_) {}
    }
  }

  function capSetMode(on) {
    capOn = !!on;
    if (!capOn) { capStatus(""); capShowHelp(false); }
    // Pressing Capture always puts a fresh rectangle in the middle of what
    // is currently on screen. Keeping the previous one sounds tidier and is
    // not: after panning somewhere else it is off-screen, and pressing the
    // button appears to do nothing at all.
    else { capDefaultRegion(); setMenu(true); }
    // No crosshair: nothing is drawn by dragging the sky any more, and a
    // crosshair over a frame that can still be clicked is a lie about what
    // the pointer does.
    canvas.style.cursor = "grab";
    capUpdateUI();
    schedule();
  }

  function capClear() {
    capP1 = capP2 = capP3 = null;
    capDragHandle = 0;
    capStatus("");
    capUpdateUI();
    schedule();
  }

  /* Is this press on one of the three handles? Returns 1, 2, 3 or 0.
   * Screen-space, so the target stays the same size however far in the view
   * is zoomed. */
  function capHandleAt(clientX, clientY) {
    const R = 20;
    let best = 0, bestD = R;
    const cand = [[1, capP1], [2, capP2], [3, capP3Handle()]];
    for (const pair of cand) {
      const q = pair[1] && screenAt(pair[1]);
      if (!q) continue;
      const d = Math.hypot(q[0] - clientX, q[1] - clientY);
      if (d <= bestD) { bestD = d; best = pair[0]; }
    }
    return best;
  }

  /* Pointer handling while capture mode is on. Returns true when the event
   * belongs to the capture and the dome's own pan/zoom must not also act. */
  function capPointerDown(e) {
    if (!capOn || capBusy) return false;
    const h = capHandleAt(e.clientX, e.clientY);
    if (!h) return false;   // not a handle: the sky pans, as it always does
    capDragHandle = h;
    return true;
  }

  function capPointerMove(e) {
    if (!capOn || !capDragHandle) return false;
    const d = dirAt(e.clientX, e.clientY);
    if (capDragHandle === 1) capP1 = d;
    else if (capDragHandle === 2) capP2 = d;
    else capP3 = d;
    capUpdateUI();
    schedule();
    return true;
  }

  function capPointerUp() {
    if (!capDragHandle) return false;
    capDragHandle = 0;
    capUpdateUI();
    schedule();
    return true;
  }

  // ── Picking ───────────────────────────────────────────────────────
  /* Screen point -> look direction -> the frame under it. Exact: the
   * direction is put through each frame's forward WCS and tested against
   * its pixel bounds, so the hit region is the real footprint. */
  function dirAt(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = 1 - ((clientY - rect.top) / rect.height) * 2;
    const t = Math.tan(cam.fov * DEG / 2);
    const aspect = rect.width / rect.height;
    const { f, r: rt, u } = basis();
    const d = [
      f[0] + rt[0] * ndcX * t * aspect + u[0] * ndcY * t,
      f[1] + rt[1] * ndcX * t * aspect + u[1] * ndcY * t,
      f[2] + rt[2] * ndcX * t * aspect + u[2] * ndcY * t,
    ];
    const n = Math.hypot(d[0], d[1], d[2]) || 1;
    return [d[0] / n, d[1] / n, d[2] / n];
  }

  /* The direction of a frame's SUBJECT, cached on the shot.
   *
   * `obj` is the catalogued position published with the frame. It is not the
   * frame centre, and the difference is the whole point: measured over 120
   * solved frames the subject sits a median 6.0' from its own frame's centre,
   * 40.8' at the 90th percentile, 181.6' at worst — and M 8's frames put the
   * Lagoon 85.3' off centre. Ranking by centre would hand the Lagoon to a
   * neighbouring frame, which is exactly the case this exists to fix.
   *
   * Frames with no catalogued position (solar-system bodies, uncatalogued
   * fields) fall back to their centre, which is the best guess available. */
  function subjectVec(s) {
    if (s._subj) return s._subj;
    let v;
    if (s.obj && s.obj.length === 2) {
      v = vec(s.obj[0] * DEG, s.obj[1] * DEG);
    } else {
      const [iw, ih] = s.wcs.image_size;
      const [ra, dec] = pixToSky(iw / 2, ih / 2, s.wcs);
      v = vec(ra, dec);
    }
    s._subj = v;
    return v;
  }

  /* Every frame the cursor is inside, nearest subject first.
   *
   * The album revisits targets, so ~13.5% of the footprint area is overlap
   * and a cursor is routinely inside several frames at once. Returning the
   * topmost one made the frames underneath unreachable: you could see a
   * target and have no way to click it.
   *
   * Containment still gates the list — a frame the cursor is not inside is
   * never a candidate, so this can never fly somewhere the viewer is not
   * pointing. Among the ones it IS inside, nearest subject wins, and draw
   * order breaks ties so two frames of the same object behave as before. */
  /* Is this screen point inside that frame's footprint? Shared so the pick
   * order and the "is this frame filling the view" test can never disagree
   * about what counts as inside. */
  function containsAt(s, clientX, clientY) {
    const d = dirAt(clientX, clientY);
    const dec = Math.asin(Math.max(-1, Math.min(1, d[2])));
    const ra = Math.atan2(d[1], d[0]);
    const p = skyToPix(ra, dec, s.wcs);
    if (!p) return false;
    const [iw, ih] = s.wcs.image_size;
    return p[0] >= 0 && p[0] <= iw && p[1] >= 0 && p[1] <= ih;
  }

  function pickAll(clientX, clientY) {
    const d = dirAt(clientX, clientY);
    const dec = Math.asin(Math.max(-1, Math.min(1, d[2])));
    const ra = Math.atan2(d[1], d[0]);
    const hits = [];
    for (let i = 0; i < shots.length; i++) {
      const w = shots[i].wcs;
      const p = skyToPix(ra, dec, w);
      if (!p) continue;
      const [iw, ih] = w.image_size;
      if (p[0] < 0 || p[0] > iw || p[1] < 0 || p[1] > ih) continue;
      const sv = subjectVec(shots[i]);
      // Both are unit vectors, so the dot product orders by angle without
      // an acos per frame per pointer move.
      hits.push([i, d[0] * sv[0] + d[1] * sv[1] + d[2] * sv[2]]);
    }
    /* A BACKDROP never outranks a real photograph.
     *
     * The sort is by nearness to each frame's SUBJECT, which is right for
     * frames of comparable size and wrong the moment one of them spans 1900
     * square degrees: click near the middle of the wide Milky Way and its
     * centre is closer to the cursor than a dedicated frame sitting two
     * degrees off, so the backdrop would take the click — and take it away
     * from the photograph the viewer was aiming at. Behind everything else
     * has to mean behind it for the pointer too, not just in the compositor. */
    hits.sort((a, b) => (Number(!!shots[a[0]].bg) - Number(!!shots[b[0]].bg))
                     || (b[1] - a[1]) || (a[0] - b[0]));
    return hits.map((h) => h[0]);
  }

  function pick(clientX, clientY) {
    const hits = pickAll(clientX, clientY);
    return hits.length ? hits[0] : -1;
  }

  // ── HUD ───────────────────────────────────────────────────────────
  function fmtRa(raRad) {
    let h = ((raRad / DEG) / 15 + 24) % 24;
    const hh = Math.floor(h), mm = Math.floor((h - hh) * 60);
    return `${hh}h ${String(mm).padStart(2, "0")}m`;
  }
  function fmtDec(decRad) {
    const d = decRad / DEG;
    const sign = d < 0 ? "-" : "+";
    const a = Math.abs(d);
    return `${sign}${Math.floor(a)}° ${String(Math.floor((a % 1) * 60)).padStart(2, "0")}'`;
  }

  /* Arc across the height of the view. Degrees while there is more than one
   * of them, arcminutes below — 0.4 deg says less than 24'. */
  function fmtArc(deg) {
    if (deg >= 10) return `${deg.toFixed(0)}°`;
    if (deg >= 1) return `${deg.toFixed(1)}°`;
    return `${(deg * 60).toFixed(0)}′`;
  }

  function updateHud() {
    const el = document.getElementById("dome-readout");
    if (!el) return;
    const { f } = basis();
    const dec = Math.asin(Math.max(-1, Math.min(1, f[2])));
    const ra = Math.atan2(f[1], f[0]);
    el.textContent = `RA ${fmtRa(ra)}   Dec ${fmtDec(dec)}   ·   ${fmtArc(cam.fov)} across`;
    const name = document.getElementById("dome-hover");
    if (name) {
      // The second click only exists once a frame fills the view, so it is
      // only offered then — an always-on "click to open" would be wrong
      // most of the time, since most clicks fly rather than open.
      // With ~13.5% of the album overlapping, the frame being offered is
      // often one of several under the cursor. Saying how many turns "why
      // can't I get at that one" into "move a little and I will".
      const stacked = hoveredStack > 1
        ? `   ·   ${hoveredStack} frames here, nearest subject shown` : "";
      if (hoveredObj) {
        // Say how many photographs hold it and which one a click opens, so
        // "why did it take me to that one" never has to be asked.
        const n = (hoveredObj.inShots || []).length;
        const mins = (i) => {
          const t = Number(shots[i] && shots[i].integrationS) || 0;
          return t >= 60 ? `${Math.round(t / 60)} min` : `${Math.round(t)} s`;
        };
        const best = bestShotFor(hoveredObj);
        name.textContent = (hoveredObj.n || hoveredObj.id)
          + (hoveredObj.t ? `   ·   ${hoveredObj.t}` : "")
          + (n > 1 ? `   ·   in ${n} photographs` : "")
          + (best >= 0 ? `   ·   click to open the deepest (${mins(best)})` : "");
      } else {
        name.textContent = hovered >= 0
          ? (shots[hovered].label || "") + stacked +
            (isFramed(hovered) ? "   ·   click again to open" : "")
          : "";
      }
      name.classList.toggle("is-on", !!hoveredObj || hovered >= 0);
    }
    // Say when a sharper texture is on its way, so the second or two a
    // frame spends soft reads as loading rather than as the limit.
    const det = document.getElementById("dome-detail");
    if (det) {
      det.textContent = inflight > 0 ? "sharpening…" : "";
      det.classList.toggle("is-on", inflight > 0);
    }
    paintZoomBar();
  }

  // ── Fly to a frame ────────────────────────────────────────────────
  /* Clicking a frame flies the camera onto it instead of leaving the dome.
   * A click on a map should move the map — and the frame you clicked is
   * usually a couple of degrees across, which is the one thing dragging
   * and scrolling to it is genuinely awkward at.
   *
   * The photo itself stays one click away: once a frame fills the view,
   * clicking it again opens it in the album below. Without that the dome
   * would be a dead end you could only leave by closing. */
  /* Must equal gallery.js's FLIGHT_MS. The album zooms and the dome zooms are
   * halves of one movement across the hand-off; if the two durations differ, the
   * second half starts before the first has finished and the seam shows. The
   * owner asked for the whole thing slower, so both went from 780/560 to 1100. */
  const FLY_MS = 1100;
  let flying = null;

  /* Field that frames a photo with a little air around it. Sized on the
   * footprint's diagonal, which is the one measure that does not depend on
   * how the frame happens to be rotated on the sky — a fit computed from
   * the long edge would clip the corners of a frame lying at 45 degrees. */
  function fitFov(s) {
    return clampFov((2 * s.radius / DEG) * 1.06);
  }

  function cancelFlight() {
    if (!flying) return;
    cancelAnimationFrame(flying);
    flying = null;
    /* A flight cut short (wheel, drag, keyboard) must not leave the seam
     * effects where the last frame put them: the neighbours would stay
     * half-suppressed and the flight frame half-brightened until the next
     * flight — a sky that never finishes assembling. */
    flightPedestal = 0;
    flightBlend = 0;
    flightGainHold = 0;
  }

  function flyTo(s) {
    cancelFlight();
    const fromYaw = cam.yaw, fromPitch = cam.pitch, fromFov = cam.fov;
    const toPitch = Math.asin(Math.max(-1, Math.min(1, s.centre[2])));
    let toYaw = Math.atan2(s.centre[1], s.centre[0]);
    // Go the short way round, so a frame just west of RA 0 does not send
    // the camera all the way back through 23h.
    while (toYaw - fromYaw > Math.PI) toYaw -= 2 * Math.PI;
    while (toYaw - fromYaw < -Math.PI) toYaw += 2 * Math.PI;
    const toFov = fitFov(s);
    // Order the texture the landing will want now, so the ~800 ms of
    // flight is spent fetching it rather than starting after touchdown.
    const li = wantedLevelAt(s, toFov);
    if (li > s.detailLevel) loadDetail(s, li);
    // The landing ripples a few frames around the destination; the sky the
    // flight crosses does not move (see animPump).
    animTap(s);
    const t0 = (typeof performance !== "undefined" ? performance.now() : Date.now());
    const step = () => {
      const now = (typeof performance !== "undefined" ? performance.now() : Date.now());
      const k = Math.min(1, (now - t0) / FLY_MS);
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      cam.yaw = fromYaw + (toYaw - fromYaw) * e;
      cam.pitch = fromPitch + (toPitch - fromPitch) * e;
      // Field eased geometrically, not linearly. Halving the field is the
      // same visual step whether it happens at 60 degrees or at 2, so a
      // linear ramp crawls at the start and lurches at the end.
      cam.fov = fromFov * Math.pow(toFov / fromFov, e);
      draw(); updateHud();
      if (k < 1) { flying = requestAnimationFrame(step); }
      // The flight drew every frame itself; hand the ripple back to schedule().
      else { flying = null; refineSoon(0); if (introActive()) schedule(); }
    };
    flying = requestAnimationFrame(step);
  }

  /* Arrive from the album at exactly FOV_HANDOFF (50′), then ease out to
   * FOV_ARRIVE (4°). The hand-off camera comes from the shot's WCS
   * (wcsHandoff), and the roll is set so the picture arrives at the SAME
   * rotation the album had on screen. introStop() runs first so every shot — and in
   * particular the neighbours within a few degrees — is already at its final
   * place with ZERO fly-in when the zoom-out begins: the sky looks real on
   * arrival instead of assembling itself. */
  /* `fileWcs` is the solve the ALBUM paints its file through — publish ships
   * it in the file's own pixel frame (crop, warp and downscale folded in).
   * The dome's own `s.wcs` describes the ORIGINAL its texture was cut from;
   * the two share the sky but not, for a compare-slider member, the centre or
   * the exact rotation. The hand-off must converge on what the album shows,
   * so pointing and roll come from the file's solve when it is given. */
  function enterFlight(path, albumRotDeg, arriveFovDeg, pedestal, fileWcs) {
    const i = shots.findIndex((s) => s.path === path);
    if (i < 0) return false;
    const s = shots[i];
    const fw = (fileWcs && fileWcs.cd && fileWcs.crpix && fileWcs.image_size) ? fileWcs : s.wcs;
    const h = wcsHandoff(fw);
    cam.pitch = Math.max(-89.5 * DEG, Math.min(89.5 * DEG, h.decDeg * DEG));
    cam.yaw = h.raDeg * DEG;
    /* Arrive at the photograph's OWN rotation, matching what the album had on
     * screen, rather than snapping to celestial north — and leave the alignment
     * disengaged so the first drag does not undo it. `turnDeg` carries the
     * quarter turn the album applies to portrait sources. */
    /* Two separate quarter turns stack up between the WCS and the screen, and
     * missing either one lands the dome 90° out:
     *
     *   1. The PUBLISHED FILE may be rotated relative to its WCS. Every stack in
     *      sky_map is portrait by image_size (201 of 201), yet the shipped JPEG
     *      can be landscape — the pipeline turned the pixels and the WCS still
     *      describes the original. Compare the two aspects to detect it.
     *   2. The ALBUM then turns a portrait file on its side with a CSS rotation.
     *
     * `filePortrait` is the shipped file's own aspect, measured by gallery.js
     * after it preloads the image. */
    /* `albumRotDeg` is the album's ACTUAL on-screen rotation, measured by
     * gallery.js from the slide stage's computed transform — not inferred. CSS
     * rotation is clockwise and the camera roll has the opposite sense, so the
     * dome needs the NEGATIVE of it. Measured: with +90 the photograph's top
     * landed at screen-LEFT (+y·right = -1.0000), a half turn out, which is why
     * a symmetric nebula looked simply unrotated. -90 puts it at screen-right.
     *
     * Applied through setAlignment so this goes down the same path as the N-S
     * button, and so a later drag holds the orientation. */
    const turn = (turnOverride === null) ? -(albumRotDeg || 0) : turnOverride;
    /* Match the album's brightness exactly.
     *
     * The shader divides the accumulation by its own weight (a.rgb / a.a), so a
     * lone frame renders at its texture's own values times uGain — i.e. at
     * uGain 1.0 the dome shows the JPEG's pixels, which is precisely what the
     * album is showing. The slider (persisted, default 1.5) is NOT touched: the
     * seam is drawn through liveGain(), which holds 1.0 here and eases to the
     * slider's value as the seam releases. */
    IMAGE_ALIGN.pole = shotUpDir(fw);
    IMAGE_ALIGN.extraDeg = turn;
    setAlignment(ALIGNMENTS.indexOf(IMAGE_ALIGN));
    lastArrival = { path, albumRotDeg: albumRotDeg || 0, turnUsed: turn,
                    rollRad: cam.roll, rollDeg: cam.roll / DEG };
    /* NOT reset here: setAlignment above deliberately engages the Image
     * alignment, so a drag keeps the photograph's orientation instead of
     * snapping to celestial north. Pressing N-S cycles away from it. */
    introStop();                                   // zero fly-in for neighbours
    /* Arrive at the field the ALBUM measured, not at a constant. Clamped to the
     * dome's own limits; falls back to FOV_HANDOFF if the album could not
     * measure. Remembered so the exit returns to exactly the same field. */
    handoffFov = (isFinite(arriveFovDeg) && arriveFovDeg > 0)
      ? Math.max(FOV_MIN, Math.min(FOV_MAX, arriveFovDeg))
      : FOV_HANDOFF;
    cam.fov = handoffFov;
    flightShotIdx = i;
    /* Vertical extent of the frame as displayed (the album turned it a quarter
     * turn, so that is its WIDTH); 90% of it so the release completes before the
     * frame's edge reaches the viewport edge. */
    {
      const ext = (Math.abs(((albumRotDeg || 0) % 180)) > 45) ? h.widthDeg : h.fovDeg;
      flightReleaseFov = Math.max(handoffFov * 1.05, (ext || 0) * 0.9);
    }
    flightPedestalFull = (isFinite(pedestal) && pedestal > 0) ? Math.min(0.5, pedestal) : 0;
    flightPedestal = flightPedestalFull;      // full strength at the seam
    flightBlend = 1;                          // this frame alone, at the seam
    flightGainHold = 1;                       // and at gain 1.0
    highlightShot(s);                              // yellow region rectangle
    /* Be at full resolution BEFORE the zoom-out starts.
     *
     * The owner saw the picture "partially load in" during the zoom-out: the
     * flight began immediately and the frame's detail tier arrived while the
     * camera was already moving, so the image sharpened mid-animation. The tier
     * needed is the one for the hand-off field, which is the tightest point of
     * the whole flight — get that in first and everything after it is a zoom OUT,
     * which never needs more detail than it already has.
     *
     * Bounded: if the fetch stalls we fly anyway after ARRIVE_WAIT_MS rather than
     * sitting on a frozen frame. The arrival view is drawn while waiting, so the
     * hold looks like the hand-off holding still, not like a hang. */
    const wantTier = capTierFor(s, surfaceH() / handoffFov);
    loadBase(s);
    if (wantTier > s.detailLevel) loadDetail(s, wantTier);
    const tierReady = () =>
      (s.detailLevel >= wantTier || s.detailLevel >= s.maxLevel) && inflight <= 0;

    let t0 = (typeof performance !== "undefined" ? performance.now() : Date.now());
    cancelFlight();
    const step = () => {
      const now = (typeof performance !== "undefined" ? performance.now() : Date.now());
      const k = Math.min(1, (now - t0) / FLY_MS);
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      cam.fov = flightFovFrom(handoffFov, e);
      /* Geometry releases by FIELD (the neighbours must be back before the
       * frame's edge reaches the viewport); BRIGHTNESS eases with the flight
       * itself — the same curve the zoom follows, over its whole length — so the
       * change from album level to dome level reads as part of the movement
       * rather than a step at the switch. */
      flightBlend = seamHold(cam.fov);                  // 1 at the seam, 0 by the frame edge
      flightPedestal = flightPedestalFull * (1 - e);
      flightGainHold = 1 - e;
      draw(); updateHud();
      if (k < 1) { flying = requestAnimationFrame(step); }
      else { flying = null; flightPedestal = 0; flightBlend = 0; flightGainHold = 0; refineSoon(0); if (introActive()) schedule(); }
    };
    /* Hold at the hand-off field until the detail is in, then fly. */
    const ARRIVE_WAIT_MS = 2500;
    const waitStart = Date.now();
    const begin = () => {
      const held = Date.now() - waitStart;
      if ((tierReady() && held >= debugHoldMs)
          || held > Math.max(ARRIVE_WAIT_MS, debugHoldMs)) {
        t0 = (typeof performance !== "undefined" ? performance.now() : Date.now());
        flying = requestAnimationFrame(step);
        return;
      }
      draw(); updateHud();          // the arrival view, holding still
      setTimeout(begin, 100);
    };
    begin();
    schedule();
    return true;
  }

  /* Reverse of enterFlight: zoom IN to FOV_HANDOFF (50′), then hand back to the
   * caller (which closes the dome and reveals the album). */
  /* `opts` is supplied when the exit is for a DIFFERENT photograph than the
   * one the flight arrived on — a frame clicked inside the dome. Then this is
   * not merely the reverse of the entry: the dome must arrive at THAT frame's
   * orientation (the album will show it turned its own way), with THAT frame's
   * brightness pedestal, at the hand-off field the album's reveal will start
   * from. The roll is eased alongside the pointing and the field so the whole
   * thing reads as one movement. Without opts it is the plain return leg. */
  function exitFlight(path, done, opts) {
    const i = shots.findIndex((s) => s.path === path);
    if (i < 0) { if (done) done(); return; }
    const ow = opts && opts.wcs;
    const fw = (ow && ow.cd && ow.crpix && ow.image_size) ? ow : shots[i].wcs;   // see enterFlight
    let toRoll = cam.roll, dRoll = 0;
    if (opts && isFinite(opts.albumRotDeg)) {
      handoffFov = FOV_HANDOFF;                    // the reveal zooms to exactly this
      const rot = opts.albumRotDeg;
      toRoll = rollForShot(fw, (turnOverride === null) ? -rot : turnOverride);
      dRoll = (toRoll - cam.roll) % (2 * Math.PI);
      if (dRoll > Math.PI) dRoll -= 2 * Math.PI;
      if (dRoll < -Math.PI) dRoll += 2 * Math.PI;
      flightPedestalFull = (isFinite(opts.pedestal) && opts.pedestal > 0) ? Math.min(0.5, opts.pedestal) : 0;
      // the Image alignment now means THIS frame's orientation
      IMAGE_ALIGN.pole = shotUpDir(fw);
      IMAGE_ALIGN.extraDeg = (turnOverride === null) ? -rot : turnOverride;
      lastArrival = { path, albumRotDeg: rot, turnUsed: IMAGE_ALIGN.extraDeg,
                      rollRad: toRoll, rollDeg: toRoll / DEG, via: "dome-click" };
    }
    if (cam.fov <= handoffFov && !dRoll) { if (done) done(); return; }
    const t0 = (typeof performance !== "undefined" ? performance.now() : Date.now());
    const fromFov = cam.fov, fromRoll = cam.roll;
    /* Zoom in ON THAT FRAME, not on wherever the camera happens to point.
     * Two callers need this: the close button, after the viewer has dragged the
     * sky somewhere else, and a click on a frame that is off to one side. Both
     * want the zoom to converge on the picture they are about to see in the
     * album, so the pointing is eased alongside the field rather than snapped. */
    const h = wcsHandoff(fw);
    flightShotIdx = i;
    const fromYaw = cam.yaw, fromPitch = cam.pitch;
    const toPitch = Math.max(-89.5 * DEG, Math.min(89.5 * DEG, h.decDeg * DEG));
    // Take the short way round the sphere rather than the long way.
    let dYaw = (h.raDeg * DEG - fromYaw) % (2 * Math.PI);
    if (dYaw > Math.PI) dYaw -= 2 * Math.PI;
    if (dYaw < -Math.PI) dYaw += 2 * Math.PI;
    cancelFlight();
    const step = () => {
      const now = (typeof performance !== "undefined" ? performance.now() : Date.now());
      const k = Math.min(1, (now - t0) / FLY_MS);
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      cam.fov = handoffFov * Math.pow(fromFov / handoffFov, 1 - e);
      cam.yaw = fromYaw + dYaw * e;
      cam.pitch = fromPitch + (toPitch - fromPitch) * e;
      cam.roll = fromRoll + dRoll * e;                  // to the clicked frame's orientation
      flightBlend = seamHold(cam.fov);                  // rises to 1 as the seam approaches
      flightPedestal = flightPedestalFull * e;          // brightness: with the flight, see enterFlight
      flightGainHold = e;
      draw(); updateHud();
      if (k < 1) { flying = requestAnimationFrame(step); }
      else { flying = null; if (done) done(); }
    };
    flying = requestAnimationFrame(step);
  }

  /* The three alignment frames the N↔S control cycles. Each is the POLE the
   * dome's "up" should point at, as a unit vector in the dome's basis
   * (x=cos(dec)cos(ra), y=cos(dec)sin(ra), z=sin(dec)). */
  const ALIGNMENTS = [
    { key: "earth",   label: "Earth",        pole: [0, 0, 1] },
    { key: "solar",   label: "Solar System",
      pole: vec(270 * DEG, 66.5607 * DEG) },                     // ecliptic north
    { key: "galactic", label: "Milky Way",
      pole: vec(192.85948 * DEG, 27.12825 * DEG) },              // galactic north
  ];
  /* The arrival orientation is applied through setAlignment — the SAME code the
   * N-S button runs — rather than by poking cam.roll. The owner asked for exactly
   * that: "align the entire sky dome using the code that is already inside that
   * button". This slot's pole is the photograph's own "up", filled in on arrival,
   * and `extraDeg` carries the rotation the album applies on screen. Pressing the
   * N-S control then cycles away from it to Earth / Solar System / Milky Way. */
  /* `fixedRoll: true` means this slot holds a ROLL ANGLE, not a pole. The
   * Image slot's "pole" is the photograph's up-direction, which sits only 90 deg
   * from the frame's centre — re-solving the roll against it on every camera
   * move (the way Earth / Solar System / Milky Way track a distant pole) made
   * the whole sky twist as the view drifted, which is what the owner saw as
   * "weird movements" when zooming out in image alignment. What he asked for is
   * to KEEP the orientation the picture arrived with; that is a constant. */
  const IMAGE_ALIGN = { key: "image", label: "Image", pole: [0, 0, 1], extraDeg: 0, fixedRoll: true };
  ALIGNMENTS.unshift(IMAGE_ALIGN);
  let alignIdx = 1;                      // default to Earth, not Image
  /* Is an alignment actively holding "up", or is the camera keeping whatever
   * rotation it arrived with?
   *
   * This exists because the two requirements genuinely conflict. Arriving from a
   * flight must KEEP the photograph's own rotation — snapping to celestial north
   * on entry is the motion sickness the owner asked us to avoid. But once the
   * viewer presses the N-S control they want "up" to track the chosen pole as
   * they drag. So the pole is only enforced after the control has been used:
   * before that, a drag leaves cam.roll alone. */
  let alignEngaged = false;
  function setAlignment(idx) {
    alignIdx = ((idx % ALIGNMENTS.length) + ALIGNMENTS.length) % ALIGNMENTS.length;
    alignEngaged = true;                 // the viewer asked for a pole; hold it
    cam.roll = rollToPole(ALIGNMENTS[alignIdx].pole, cam.yaw, cam.pitch)
      + (ALIGNMENTS[alignIdx].extraDeg || 0) * DEG;
    updateAlignmentUi();
    schedule(); updateHud();
  }
  function cycleAlignment() { setAlignment(alignIdx + 1); }
  function updateAlignmentUi() {
    const btn = document.getElementById("dome-align-btn");
    const word = document.getElementById("dome-align-label");
    if (btn) btn.setAttribute("aria-label", `Align to ${ALIGNMENTS[alignIdx].label}`);
    if (word) word.textContent = ALIGNMENTS[alignIdx].label;
  }
  /* The alignment holds the POLE, not the angle: when the viewer drags to a
   * different part of the sky, "up" follows the chosen pole. */
  function keepAlignment() {
    if (!alignEngaged) return;           // arrived-with rotation stands until asked
    if (ALIGNMENTS[alignIdx].fixedRoll) return;   // Image: the roll is a constant
    cam.roll = rollToPole(ALIGNMENTS[alignIdx].pole, cam.yaw, cam.pitch)
      + (ALIGNMENTS[alignIdx].extraDeg || 0) * DEG;
  }

  /* Is this frame the one currently filling the view? Asked of the camera
   * rather than remembered from the last fly-to, so nudging the view a
   * little does not silently disarm the second click. */
  function isFramed(i) {
    if (flying) return false;
    const rect = canvas.getBoundingClientRect();
    // Containment, NOT pick(). flyTo centres a frame's geometric centre,
    // but pick() ranks by subject, and a subject can sit far from its own
    // frame's centre — M 8 puts the Lagoon 85' off centre. Asking pick()
    // here would let a neighbour win the centre pixel and silently disarm
    // "click again to open" on the very frame just flown to.
    return cam.fov <= fitFov(shots[i]) * 1.35
        && containsAt(shots[i], rect.left + rect.width / 2,
                      rect.top + rect.height / 2);
  }

  /* Open the photograph that best shows this object, and say so if there
   * is none — an object can be circled but sit in a frame that never
   * shipped a viewable image. */
  function openObject(o) {
    const i = bestShotFor(o);
    if (i < 0) return false;
    if (typeof window.openPhotoByPath === "function") {
      close();
      window.openPhotoByPath(shots[i].path);
      return true;
    }
    // No album to hand off to (the dome served on its own): fly there
    // instead, which is the most this context can do.
    flyTo(shots[i]);
    return true;
  }

  function clickFrame(i) {
    if (isFramed(i)) {
      /* The owner asked for the SAME animation as entering: zoom in on the
       * clicked frame, then zoom out in the album with it in the showcase slot.
       * The album owns that sequence, so hand the whole thing over when it
       * offers to take it; `close()` + a bare open (below) is the old
       * no-animation path, kept for when the dome is served on its own. */
      if (typeof window.domePhotoChosen === "function") {
        window.domePhotoChosen(shots[i].path);
        return;
      }
      if (typeof window.openPhotoByPath === "function") {
        close();
        window.openPhotoByPath(shots[i].path);
      }
      return;
    }
    flyTo(shots[i]);
  }

  // ── Search ────────────────────────────────────────────────────────
  /* Type a target, and the dome swings to where that photograph is on the
   * sky. Matching is over what the map already knows — the object id and
   * the catalogue name of every frame — plus whatever aliases the album
   * hands over, so "Andromeda" finds the frame labelled M 31.
   *
   * Only photographed frames are searchable. A search box that also
   * accepted uncaptured catalogue objects would swing the view to empty
   * sky and leave the viewer wondering what they had done wrong. */
  let aliases = {};

  function searchHits(q) {
    const needle = q.trim().toLowerCase().replace(/\s+/g, "");
    if (!needle) return [];
    const scored = [];
    for (let i = 0; i < shots.length; i++) {
      const s = shots[i];
      const names = [s.objId || "", s.label || ""]
        .concat(aliases[s.objId] || []);
      let best = -1;
      for (const n of names) {
        const hay = String(n).toLowerCase().replace(/\s+/g, "");
        if (!hay) continue;
        if (hay === needle) best = Math.max(best, 3);
        else if (hay.startsWith(needle)) best = Math.max(best, 2);
        else if (hay.includes(needle)) best = Math.max(best, 1);
      }
      if (best > 0) scored.push({ i, score: best, label: s.label || s.objId });
    }
    // Best match first; among equals, the deepest frame of that target is
    // the one worth flying to, and lower index means drawn on top.
    scored.sort((a, b) => b.score - a.score || a.i - b.i);
    // One entry per target — eight frames of M 31 as eight results would
    // push every other match off the list.
    const seen = new Set();
    return scored.filter((h) => {
      const k = shots[h.i].objId || shots[h.i].label;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }).slice(0, 8);
  }

  function bindSearch() {
    const input = document.getElementById("dome-search");
    const list = document.getElementById("dome-search-results");
    if (!input || !list) return;
    let hits = [], sel = -1;

    const close = () => { list.hidden = true; list.innerHTML = ""; sel = -1; };
    const paint = () => {
      if (!hits.length) { close(); return; }
      list.hidden = false;
      list.innerHTML = hits.map((h, k) =>
        `<button type="button" class="dome-search-hit${k === sel ? " is-on" : ""}" ` +
        `data-k="${k}">${h.label.replace(/[&<>"']/g, (c) => (
          { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
        ))}</button>`).join("");
      list.querySelectorAll(".dome-search-hit").forEach((b) => {
        b.addEventListener("click", () => go(Number(b.dataset.k)));
      });
    };
    const go = (k) => {
      const h = hits[k] || hits[0];
      if (!h) return;
      close();
      input.blur();
      flyTo(shots[h.i]);
    };

    input.addEventListener("input", () => { hits = searchHits(input.value); sel = 0; paint(); });
    input.addEventListener("focus", () => { if (input.value) { hits = searchHits(input.value); paint(); } });
    input.addEventListener("blur", () => setTimeout(close, 140));
    input.addEventListener("keydown", (e) => {
      // Escape closes the results, not the dome — the dome's own Escape
      // handler would otherwise shut the whole thing while you are typing.
      if (e.key === "Escape") { e.stopPropagation(); close(); input.blur(); return; }
      if (!hits.length) return;
      if (e.key === "ArrowDown") { sel = Math.min(sel + 1, hits.length - 1); paint(); e.preventDefault(); }
      else if (e.key === "ArrowUp") { sel = Math.max(sel - 1, 0); paint(); e.preventDefault(); }
      else if (e.key === "Enter") { go(Math.max(sel, 0)); e.preventDefault(); }
    });
  }

  // ── Zoom bar ──────────────────────────────────────────────────────
  /* A vertical scale of the arc the view spans, with the current field
   * marked on it. Logarithmic: the range runs from 100 degrees down to
   * under one, and on a linear bar the whole useful end would be crushed
   * into the last few pixels. Bottom is the whole sky, top is as far in as
   * the imagery supports — so the top of the bar moves when the ladder in
   * publish.py changes, and the labelled end stop states where it landed. */
  const ZOOM_TICKS = [120, 60, 30, 15, 8, 4, 2, 1, 0.5];
  let zoomEls = null;

  // Position along the bar, 0 at the bottom (widest) to 1 at the top.
  function fovToPos(fov) {
    return Math.log(FOV_MAX / fov) / Math.log(FOV_MAX / fovMin());
  }
  function posToFov(p) {
    const t = Math.max(0, Math.min(1, p));
    return FOV_MAX * Math.pow(fovMin() / FOV_MAX, t);
  }

  function buildZoomScale() {
    if (!zoomEls) return;
    const lo = fovMin();
    zoomEls.track.querySelectorAll(".dome-zoom-tick").forEach((n) => n.remove());
    updateSharpFov();
    const sharpPos = fovSharp > 0 ? fovToPos(fovSharp) : 1;
    const add = (fov, cls) => {
      const el = document.createElement("i");
      el.className = "dome-zoom-tick" + (cls ? " " + cls : "");
      el.style.bottom = (fovToPos(fov) * 100).toFixed(3) + "%";
      el.innerHTML = `<b>${fmtArc(fov)}</b>`;
      zoomEls.track.appendChild(el);
    };
    for (const t of ZOOM_TICKS) {
      // Skip anything off the ends, and anything close enough to a labelled
      // marker that the two would sit on top of one another.
      if (t > FOV_MAX || t < lo) continue;
      const p = fovToPos(t);
      if (p > 0.94 || Math.abs(p - sharpPos) < 0.05) continue;
      add(t, "");
    }
    add(lo, "is-end");
    /* The bar runs to 25', but the imagery does not. Mark where the
     * sharpest texture reaches one screen pixel per texture pixel: below
     * that line zooming reveals more, above it the same pixels only get
     * bigger. Saying so is cheaper than pretending the top of the bar is
     * all real detail. */
    if (fovSharp > lo * 1.05 && sharpPos < 0.94) {
      add(fovSharp, "is-sharp");
      zoomEls.beyond.style.height = ((1 - sharpPos) * 100).toFixed(3) + "%";
      zoomEls.beyond.hidden = false;
    } else {
      zoomEls.beyond.hidden = true;
    }
  }

  function paintZoomBar() {
    if (!zoomEls) return;
    const p = Math.max(0, Math.min(1, fovToPos(cam.fov)));
    const pct = (p * 100).toFixed(3) + "%";
    zoomEls.marker.style.bottom = pct;
    zoomEls.fill.style.height = pct;
    zoomEls.value.textContent = fmtArc(cam.fov);
    zoomEls.track.setAttribute("aria-valuenow", String(Math.round(p * 100)));
    zoomEls.track.setAttribute("aria-valuetext", fmtArc(cam.fov) + " across");
  }

  /* The bar zooms about the middle of the view rather than about a cursor:
   * while the pointer is on the bar it is not over any part of the sky, so
   * there is nothing else to hold still. Centre-anchored zoom needs no
   * correction — the middle of the view is the look direction. */
  function setFov(f) {
    cancelFlight();
    const want = clampFov(f);
    if (want === cam.fov) return;
    cam.fov = want;
    schedule(); updateHud(); refineSoon();
  }

  function bindZoomBar() {
    const wrap = document.getElementById("dome-zoom");
    const track = document.getElementById("dome-zoom-track");
    if (!wrap || !track) return;
    zoomEls = {
      wrap, track,
      fill: document.getElementById("dome-zoom-fill"),
      beyond: document.getElementById("dome-zoom-beyond"),
      marker: document.getElementById("dome-zoom-marker"),
      value: document.getElementById("dome-zoom-value"),
    };
    buildZoomScale();

    let grabbed = false;
    const fromY = (clientY) => {
      const r = track.getBoundingClientRect();
      setFov(posToFov(1 - (clientY - r.top) / (r.height || 1)));
    };
    wrap.addEventListener("pointerdown", (e) => {
      grabbed = true;
      wrap.classList.add("is-grabbed");
      try { wrap.setPointerCapture(e.pointerId); } catch (_) {}
      fromY(e.clientY);
      e.preventDefault();
    });
    wrap.addEventListener("pointermove", (e) => { if (grabbed) fromY(e.clientY); });
    const drop = (e) => {
      if (!grabbed) return;
      grabbed = false;
      wrap.classList.remove("is-grabbed");
      try { wrap.releasePointerCapture(e.pointerId); } catch (_) {}
    };
    wrap.addEventListener("pointerup", drop);
    wrap.addEventListener("pointercancel", drop);
    // Scrolling over the bar zooms too, so the pointer does not have to
    // travel back to the sky to keep going.
    wrap.addEventListener("wheel", (e) => {
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      const d = Math.max(-400, Math.min(400, e.deltaY * unit));
      setFov(cam.fov * Math.exp(d * 0.0022));
    }, { passive: false });
    track.addEventListener("keydown", (e) => {
      const step = e.shiftKey ? 4 : 1;
      if (e.key === "ArrowUp" || e.key === "ArrowRight") setFov(cam.fov / Math.pow(1.25, step));
      else if (e.key === "ArrowDown" || e.key === "ArrowLeft") setFov(cam.fov * Math.pow(1.25, step));
      else if (e.key === "Home") setFov(fovMin());
      else if (e.key === "End") setFov(FOV_MAX);
      else return;
      e.preventDefault();
    });
  }

  // ── Input ─────────────────────────────────────────────────────────
  function bindInput() {
    let dragging = false, moved = 0, lx = 0, ly = 0, pointers = new Map();
    let pinchStart = 0, fovStart = 0;

    canvas.addEventListener("pointerdown", (e) => {
      // Any hand on the controls wins over an animation in progress.
      cancelFlight();
      // Capture mode owns single-pointer presses: they draw and drag the
      // region. Two fingers still pinch, so the view can be framed without
      // leaving the mode.
      if (capOn && pointers.size === 0 && capPointerDown(e)) {
        try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
        pointers.set(e.pointerId, [e.clientX, e.clientY]);
        return;
      }
      pointers.set(e.pointerId, [e.clientX, e.clientY]);
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinchStart = Math.hypot(a[0] - b[0], a[1] - b[1]);
        fovStart = cam.fov;
        dragging = false;
        return;
      }
      dragging = true; moved = 0; lx = e.clientX; ly = e.clientY;
      canvas.setPointerCapture(e.pointerId);
    });

    canvas.addEventListener("pointermove", (e) => {
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, [e.clientX, e.clientY]);
      // After the pinch branch would be wrong (the region has to track the
      // finger), but a SECOND finger still belongs to the view: capture
      // only claims the move while exactly one pointer is down.
      if (pointers.size < 2 && capPointerMove(e)) return;
      if (pointers.size === 2 && pinchStart > 0) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
        // Anchored on the midpoint between the fingers, which also makes a
        // two-finger drag pan — the sky stays under the fingers holding it.
        const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
        const want = clampFov(fovStart * pinchStart / (d || 1));
        const dir = dirAt(mx, my);
        cam.fov = want;
        aimAt(dir, mx, my);
        schedule(); updateHud(); refineSoon();
        return;
      }
      if (!dragging) {
        // Over a capture handle: say so and stop, so the frame under it does
        // not also light up as clickable.
        if (capOn && capHandleAt(e.clientX, e.clientY)) {
          if (hovered !== -1) { hovered = -1; hoveredStack = 0; schedule(); updateHud(); }
          canvas.style.cursor = "move";
          return;
        }
        // Everything else behaves exactly as it does outside capture mode.
        // Suppressing the hover here made frames look dead — the click still
        // worked, but nothing lit up and the cursor stayed a crosshair, so
        // the dome read as unresponsive while the mode was on.
        // The circle under the cursor, if any, takes precedence in the
        // readout — it is the more specific thing to be pointing at.
        const ho = pickObject(e.clientX, e.clientY);
        if (ho !== hoveredObj) { hoveredObj = ho; schedule(); updateHud(); }
        const hits = pickAll(e.clientX, e.clientY);
        const h = hits.length ? hits[0] : -1;
        if (h !== hovered || hits.length !== hoveredStack) {
          hovered = h;
          hoveredStack = hits.length;
          schedule(); updateHud();
        }
        canvas.style.cursor = (ho || h >= 0) ? "pointer" : "grab";
        return;
      }
      const dx = e.clientX - lx, dy = e.clientY - ly;
      lx = e.clientX; ly = e.clientY;
      moved += Math.abs(dx) + Math.abs(dy);
      // One screen pixel of drag moves the sky one screen pixel: the field
      // divided by the height of the canvas is exactly the angle a pixel
      // subtends. The step is applied in the ROLLED screen basis (dragStep)
      // rather than by integrating yaw/pitch from raw deltas — the old
      // yaw += dx / cos(pitch) amplified a sideways drag up to 12.5x near a
      // pole, and stopped being sideways at all once the view was rolled.
      const rect = canvas.getBoundingClientRect();
      const perPx = (cam.fov * DEG) / (rect.height || 1);
      const s = dragStep(cam.yaw, cam.pitch, cam.roll, dx, dy, perPx);
      cam.yaw = s.yaw; cam.pitch = s.pitch;
      keepAlignment();          // "up" follows the chosen pole as you drag
      schedule(); updateHud(); refineSoon();
    });

    function release(e) {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinchStart = 0;
      if (capPointerUp(e)) {
        try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
        return;
      }
      if (!dragging) return;
      dragging = false;
      try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
      // A click, not a drag: fly onto that frame — or open it, if the view
      // is already sitting on it.
      if (moved < 6) {
        /* An object circle takes the click ahead of the frame under it.
         * Clicking a ring is a deliberate act — you aimed at a named
         * thing — where clicking bare sky is "show me what is here", and
         * the frame path still handles that below. */
        const o = pickObject(e.clientX, e.clientY);
        if (o) { openObject(o); return; }
        const i = pick(e.clientX, e.clientY);
        if (i >= 0) clickFrame(i);
      }
    }
    canvas.addEventListener("pointerup", release);
    canvas.addEventListener("pointercancel", release);

    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      // Normalised across input devices: a mouse reports a notch as ~100
      // pixels, a trackpad reports a few pixels many times a second, and
      // Firefox reports lines. Exponential in the delta, so the zoom moves
      // at the same rate per notch everywhere in a range that now spans
      // more than two decades of field.
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      const d = Math.max(-400, Math.min(400, e.deltaY * unit));
      zoomAt(Math.exp(d * 0.0022), e.clientX, e.clientY);
    }, { passive: false });
  }

  /* Keyboard zoom, about the middle of the view. Wheel and pinch both need
   * a pointing device; this is the path for anyone without one. */
  function zoomCentre(factor) {
    const rect = canvas.getBoundingClientRect();
    zoomAt(factor, rect.left + rect.width / 2, rect.top + rect.height / 2);
  }

  // ── Open / close ──────────────────────────────────────────────────
  /* Failures surface INSIDE the overlay, so it is opened first. Writing a
   * message into a panel that is still hidden means the user presses the
   * button and nothing at all happens. */
  function fail(msg) {
    if (overlay) {
      overlay.hidden = false;
      document.body.classList.add("dome-open");
      opened = true;
    }
    const el = document.getElementById("dome-readout");
    if (el) el.textContent = msg;
    const hint = document.getElementById("dome-hint");
    if (hint) hint.textContent = "";
    // Nothing to zoom into, so nothing to zoom with.
    const zoom = document.getElementById("dome-zoom");
    if (zoom) zoom.hidden = true;
    return false;
  }

  /* Bind the capture chrome. Separate from the rest because it is optional:
   * an older gallery.html without these elements must still open a working
   * dome rather than throw on a missing button. */
  function capBind() {
    const id = (k) => document.getElementById(k);
    capEls.toggle = id("dome-cap-toggle");
    capEls.panel  = id("dome-cap-panel");
    capEls.snap   = id("dome-cap-snap");
    capEls.clear  = id("dome-cap-clear");
    capEls.status = id("dome-cap-status");
    capEls.helpBtn = id("dome-cap-help-btn");
    capEls.help = id("dome-cap-help");
    capEls.helpVideo = id("dome-cap-help-video");
    capEls.helpClose = id("dome-cap-help-close");
    capEls.svg    = id("dome-cap-svg");
    capEls.poly   = id("dome-cap-poly");
    capEls.hA     = id("dome-cap-h1");
    capEls.hB     = id("dome-cap-h2");
    capEls.hC     = id("dome-cap-h3");
    capEls.guide  = id("dome-cap-guide");
    capEls.guideBtn = id("dome-cap-guide-btn");
    if (capEls.toggle) {
      capEls.toggle.addEventListener("click", () => capSetMode(!capOn));
    }
    if (capEls.snap)  capEls.snap.addEventListener("click", () => capSnap());
    if (capEls.clear) capEls.clear.addEventListener("click", () => capClear());
    if (capEls.guideBtn) {
      capEls.guideBtn.addEventListener("click", () => capCycleGuide());
    }
    if (capEls.helpBtn) {
      capEls.helpBtn.addEventListener("click", () => capShowHelp(capEls.help.hidden));
    }
    if (capEls.helpClose) {
      capEls.helpClose.addEventListener("click", () => capShowHelp(false));
    }
    capUpdateUI();
  }

  /* The tool menu. Closes on Escape and on a click anywhere else, because a
   * panel pinned over the sky is the thing this was collapsed to avoid. */
  let menuOpen = false;
  function setMenu(on) {
    menuOpen = !!on;
    const btn = document.getElementById("dome-menu-btn");
    const items = document.getElementById("dome-menu-items");
    if (items) items.hidden = !menuOpen;
    if (btn) {
      btn.classList.toggle("is-on", menuOpen);
      btn.setAttribute("aria-expanded", menuOpen ? "true" : "false");
    }
    return menuOpen;
  }

  function menuBind() {
    const btn = document.getElementById("dome-menu-btn");
    const items = document.getElementById("dome-menu-items");
    if (!btn || !items) return;
    btn.addEventListener("click", (e) => { e.stopPropagation(); setMenu(!menuOpen); });
    // A click inside the menu must not close it — the search box, the
    // toggles and the capture buttons all live in there.
    items.addEventListener("click", (e) => e.stopPropagation());
    /* The overlay used to close the menu on any click:
     *
     *   overlay.addEventListener("click", () => { if (menuOpen) setMenu(false); });
     *
     * The canvas carries only pointer handlers, so the browser still fires
     * a native `click` after every pointerdown/pointerup pair — HOWEVER FAR
     * the pointer travelled in between. Panning the sky therefore dismissed
     * the bar, which reads as the menu closing itself at random. (release()
     * does compute a `moved < 6` drag test, but it is local to that handler
     * and never reached this listener.)
     *
     * The bar now stays open until its own button is pressed again, or
     * Escape. Nothing that happens in the sky dismisses it. */
    setMenu(false);
  }

  function markersBind() {
    markerLayer = document.getElementById("dome-markers");
    const btn = document.getElementById("dome-markers-toggle");
    if (btn) btn.addEventListener("click", () => setMarkers(!markersOn));
    setMarkers(markersOn);
    circlesBind();
  }

  function alignmentBind() {
    const btn = document.getElementById("dome-align-btn");
    if (btn) btn.addEventListener("click", () => cycleAlignment());
    updateAlignmentUi();
  }

  async function ensure() {
    if (ready) return true;
    overlay = document.getElementById("dome-overlay");
    canvas = document.getElementById("dome-canvas");
    if (!overlay || !canvas) return false;
    capBind();
    markersBind();
    gainBind();
    menuBind();
    alignmentBind();
    gl = canvas.getContext("webgl", { antialias: true, alpha: false })
      || canvas.getContext("experimental-webgl");
    if (!gl) return fail("This browser has no WebGL, so the dome can't draw.");
    let data;
    try {
      // Cache-busted. GitHub Pages serves data/ with max-age=600, and the
      // dome fetched this bare — so for ten minutes after a deploy the map
      // a visitor saw was the PREVIOUS one, with the night's frames simply
      // absent. Reported as "images I took tonight are not on the dome"
      // when they were live in the file the whole time. The build stamp
      // changes every publish, so this is only cached within one build.
      const r = await fetch("data/sky_map.json?v=" + (window.BUILD_STAMP || Date.now()));
      if (!r.ok) throw new Error("HTTP " + r.status);
      data = await r.json();
    } catch (e) {
      return fail("Sky map unavailable (" + e.message + ").");
    }
    if (!data.shots || !data.shots.length) return fail("No plate-solved frames to show.");
    meta = data.coverage || null;
    // How many overlap slots the fragment stage can afford. A mat3 costs
    // three uniform vectors; WebGL 1 only guarantees sixteen in total, and
    // on a device that stingy the dome draws opaque rather than failing to
    // link. Everything below degrades by slot count, not by breaking.
    const budget = gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS) || 16;
    ovlSlots = Math.max(0, Math.min(OVERLAP_SLOTS, Math.floor((budget - 6) / 3)));
    extHalf = gl.getExtension("OES_texture_half_float");
    extHalfRT = gl.getExtension("EXT_color_buffer_half_float");
    if (extHalf) gl.getExtension("OES_texture_half_float_linear");
    prog = link(VS_TEX, fsTex(ovlSlots));
    gridProg = link(VS_LINE, FS_LINE);
    // The divide-once composite needs one extra program. If a driver
    // refuses it, fall back to drawing the footprints straight to the
    // canvas rather than taking the whole dome down with an exception —
    // a mis-weighted overlap is a much smaller fault than a blank sky.
    try {
      fullProg = link(VS_FULL, FS_FULL);
    } catch (e) {
      console.warn("sky dome: data-aware compositing unavailable, "
                   + "drawing footprints un-averaged —", e.message);
      fullProg = null;
    }
    fullBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, fullBuf);
    gl.bufferData(gl.ARRAY_BUFFER,
                  new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    aniso = gl.getExtension("EXT_texture_filter_anisotropic")
         || gl.getExtension("WEBKIT_EXT_texture_filter_anisotropic");
    if (aniso) {
      anisoMax = Math.min(8,
        gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT) || 1);
    }
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    shots = (data.shots || []).map((s) => {
      // A map written before the detail ladder existed carries only
      // `thumb`; treat that as a one-rung ladder rather than failing.
      const levels = (s.levels && s.levels.length)
        ? s.levels
        : [{ src: s.thumb, px: 320 }];
      return {
        // objId is carried, not just folded into the label: search matches
        // on it, the album's aliases are keyed by it, and goTo() addresses
        // frames by it. Without it every one of those silently matched
        // nothing at all.
        objId: s.objId || "",
        path: s.path, label: s.label || s.objId || "", wcs: s.wcs,
        levels,
        maxLevel: levels.length - 1,
        baseTex: null, baseLoading: false,
        // detailLevel 0 means "showing tier 0" — a frame with no detail
        // texture is already at the bottom rung, not at nothing, so the
        // refine pass never asks to fetch tier 0 a second time.
        detailTex: null, detailLevel: 0, detailBytes: 0,
        pendingLevel: -1, used: 0,
        // Seconds of integration behind this frame (publish.py writes it
        // from data/frame_depth.json). Undefined on an older sky_map.
        integrationS: s.integrationS,
        // A BACKDROP frame — a wide survey shot the real photographs are
        // drawn on top of, rather than averaged with. publish.py sets it
        // from {"domeBackground": true} in photo_options.json.
        bg: !!s.bg,
      };
    });
    shots.forEach((s, i) => buildShot(s, i));
    // Finest sampling anywhere in the album, in texture pixels per degree.
    // This is what sets how far the dome lets anyone zoom in.
    bestPxPerDeg = shots.reduce(
      (b, s) => Math.max(b, s.levels[s.maxLevel].px / s.degLong), 0);
    updateSharpFov();
    // buildOverlaps() is NOT called here any more. Nothing on the render
    // path reads its result: the fragment shader stopped taking neighbour
    // matrices when compositeDome moved to divide-once coverage (see the
    // fsTex comment), so `s.ovl` is written and never sampled and `s.nbrs`
    // is read only by the test seam below. At 139 frames that was 9,591
    // pair tests thrown away at boot; at 1,000 it would be 499,500.
    //
    // It is kept, and made lazy, rather than deleted — "which frames touch
    // this one" is a real question the dome will want to answer again (a
    // hover readout, a mosaic-completeness view), and it is the harness's
    // independent check on the projection maths.
    eqCount = buildGrid();
    bindInput();
    bindZoomBar();
    bindSearch();
    ready = true;

    const stat = document.getElementById("dome-stat");
    if (stat && meta) {
      let html =
        `<strong>${meta.percent.toFixed(2)}%</strong> of the sky &middot; ` +
        `${meta.unique_deg2.toFixed(0)} deg&sup2; across ${meta.photos} plate-solved frames`;
      // Stars, if the build measured them. Counted, not estimated: every
      // one is a concentrated point source detected in these frames, with
      // repeat detections of the same star merged by sky position.
      const st = meta.stars;
      if (st && st.unique) {
        html += ` &middot; <strong>${st.unique.toLocaleString()}</strong> stars`;
        stat.title =
          `${st.unique.toLocaleString()} distinct point sources from ` +
          `${st.detections.toLocaleString()} detections at ${st.sigma}σ across ` +
          `${st.frames} frames, merged within ${st.match_arcsec}". ` +
          (st.repeat_rate != null
            ? `Where two frames cover the same sky, ${(st.repeat_rate * 100).toFixed(0)}% ` +
              `were found again independently. `
            : "") +
          `${st.rejected_extended.toLocaleString()} extended sources ` +
          `(nebulosity, galaxy discs) and ` +
          `${st.rejected_spikes.toLocaleString()} single-pixel spikes were rejected.`;
      }
      stat.innerHTML = html;
    }
    return true;
  }

  async function open() {
    if (!(await ensure())) return;
    opened = true;
    overlay.hidden = false;
    // The dome maps pointers and sizes its client box from the overlay, which
    // is fixed to the viewport — unless document.body carries a transform
    // (the flight zooms body to fill the screen), which makes it the
    // containing block and inflates everything. Clear it now, after the
    // overlay is up (hiding the snap to scale 1) and before the first draw
    // measures the canvas.
    if (document.body && document.body.style) {
      document.body.style.transform = "";
      document.body.style.transformOrigin = "";
    }
    document.body.classList.add("dome-open");
    // Start looking at the richest part of the album rather than at RA 0,
    // which for this collection is empty sky.
    if (!open._once) {
      open._once = true;
      let bx = 0, by = 0, bz = 0;
      for (const s of shots) { bx += s.centre[0]; by += s.centre[1]; bz += s.centre[2]; }
      const n = Math.hypot(bx, by, bz);
      if (n > 1e-6) {
        cam.yaw = Math.atan2(by / n, bx / n);
        cam.pitch = Math.asin(Math.max(-1, Math.min(1, bz / n)));
      }
    }
    canvas.style.cursor = "grab";
    // Every open, not just the first: the arrival is how the dome says
    // "these are photographs, and each one belongs somewhere".
    introBegin();
    schedule();
    // The bar's top end is derived from the canvas, which only has a size
    // once the overlay is visible — so the scale is built here, not in
    // ensure(), and rebuilt whenever the window changes shape.
    buildZoomScale();
    updateHud();
    // Nearest frames first, so what you are looking at resolves soonest.
    const { f } = basis();
    [...shots]
      .sort((a, b) => {
        const da = a.centre[0] * f[0] + a.centre[1] * f[1] + a.centre[2] * f[2];
        const db = b.centre[0] * f[0] + b.centre[1] * f[1] + b.centre[2] * f[2];
        return db - da;
      })
      .forEach((s, i) => setTimeout(() => loadBase(s), i * 12));
    refineSoon(400);
  }

  function close() {
    // Leaving the dome leaves capture mode. Without this, reopening lands
    // you mid-capture with a stale region and a crosshair cursor.
    if (capOn) capSetMode(false);
    opened = false;
    if (overlay) overlay.hidden = true;
    document.body.classList.remove("dome-open");
    clearTimeout(refineTimer);
    cancelFlight();
    // Object labels are DOM, not GL, so hiding the overlay only hides them
    // — it does not unmake them. Clear them here so a reopen starts blank
    // rather than inheriting the last view's names.
    clearObjectLabels();
    visibleCache = [];
    hoveredObj = null;
    // Anything still in motion would keep requesting frames against a
    // hidden canvas, and would resume mid-movement on the next open.
    introStop();
    sleepDome();
  }

  function toggle() { opened ? close() : open(); }

  /* Nothing runs, and no detail is held, while nobody can see the dome.
   *
   * Closing the dome used to keep every detail texture — up to the 512 MB
   * budget, which on a Mac is unified memory — for the rest of the visit,
   * while the album was being browsed underneath, and a hidden tab kept its
   * settle timer and in-flight fetches going. A capture in progress is left
   * alone: it is waiting on exactly those textures, and its own finally
   * releases them. */
  function sleepDome() {
    clearTimeout(refineTimer);
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    cancelFlight();
    if (!capBusy) releaseAllDetail();
  }

  if (typeof document !== "undefined"
      && typeof document.addEventListener === "function") {
    document.addEventListener("visibilitychange", () => {
      if (!opened) return;
      if (document.hidden) { introStop(); sleepDome(); }
      else { schedule(); refineSoon(0); }
    });
  }

  window.addEventListener("keydown", (e) => {
    if (!opened) return;
    if (e.key === "Escape") {
      // The menu first: Escape should undo the last thing that opened, and
      // closing the whole dome out from under an open menu is a surprise.
      if (menuOpen) { setMenu(false); return; }
      close();
      return;
    }
    // Zoom without a pointing device. Ignored while a text field has focus
    // so this never steals typing from anything the album grows later.
    const tag = (document.activeElement && document.activeElement.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    if (e.key === "+" || e.key === "=") zoomCentre(1 / 1.25);
    else if (e.key === "-" || e.key === "_") zoomCentre(1.25);
    else return;
    e.preventDefault();
  });
  window.addEventListener("resize", () => {
    if (!opened) return;
    // The zoom range is fixed, but a shorter window moves the point where
    // the imagery stops adding detail, so the bar's marker has to follow.
    const f = clampFov(cam.fov);
    if (f !== cam.fov) cam.fov = f;
    schedule(); buildZoomScale(); updateHud(); refineSoon();
  });

  window.SkyDome = {
    open, close, toggle,
    isOpen: () => opened,
    /* Custom capture, exposed so the album can drive it and a harness can
     * check the geometry without a pointer. `captureRegion` reports the
     * region in the terms it is actually defined in — centre, half-angles
     * and the frames that fall inside it — rather than the screen
     * rectangle it was drawn with, which is not what gets rendered. */
    capture: {
      mode: (on) => (on === undefined ? capOn : (capSetMode(on), capOn)),
      /* Set the region from three sky directions, the same thing the three
       * handles produce: p1 and p2 are the ends of one edge, p3 sets the
       * height by its perpendicular distance from that edge. Unit vectors.
       *
       * Two are accepted as a convenience and complete themselves into a
       * 3:2 landscape frame — but nothing INFERS a rectangle from two
       * points any more, which is the whole point of the redesign. */
      setPoints: (p1, p2, p3) => {
        capP1 = p1 ? norm3(p1) : null;
        capP2 = p2 ? norm3(p2) : null;
        if (p3) {
          capP3 = norm3(p3);
        } else if (capP1 && capP2) {
          const m = norm3(add3(capP1, capP2));
          let r = add3(capP2, mul3(m, -dot3(capP2, m)));
          if (Math.hypot(r[0], r[1], r[2]) > 1e-9) {
            r = norm3(r);
            const n0 = norm3(cross3(r, m));
            const halfW = Math.abs(dot3(capP2, r) / Math.max(1e-9, dot3(capP2, m)));
            capP3 = norm3(add3(m, mul3(n0, halfW * (4 / 3))));
          }
        } else {
          capP3 = null;
        }
        capUpdateUI();
        schedule();
        return capRegion();
      },
      points: () => {
        if (!capP1 || !capP2 || !capP3) return null;
        // The tangent frame the model is DEFINED in, so a caller can move a
        // point along the edge rather than along a line of constant Dec —
        // which is not the same thing on a sphere, and differs by enough
        // (0.1% of the height on a 2-degree frame) to look like a defect.
        const m = norm3(add3(capP1, capP2));
        let r = add3(capP2, mul3(m, -dot3(capP2, m)));
        const ok = Math.hypot(r[0], r[1], r[2]) > 1e-9;
        r = ok ? norm3(r) : null;
        return {
          p1: capP1.slice(), p2: capP2.slice(), p3: capP3.slice(),
          p3Handle: (capP3Handle() || []).slice(),
          frame: ok ? { mid: m, dir: r, up: norm3(cross3(r, m)) } : null,
        };
      },
      /* Whether the outline is actually on screen. Exposed because the
       * hiding bug that put a stray mark in the middle of the dome was a
       * no-op assignment, and no geometric assertion could see it. */
      overlayShown: () => {
        const svg = capEls.svg;
        return !!svg && svg.style.display !== "none";
      },
      /* The composition guide: which one is selected, and what it actually
       * put on screen. Both halves are exposed because they fail
       * separately — a guide can be selected and draw nothing (an empty
       * <g>, a sampling loop that bailed), and lines can be on screen that
       * no longer belong to the selected guide. Neither shows up in the
       * region geometry, which is the same blind spot the outline's
       * hiding bug lived in. */
      guide: () => (CAP_GUIDES[capGuideIx] || CAP_GUIDES[0]).id,
      cycleGuide: () => { capCycleGuide(); return capGuideIx; },
      guideLines: () => Array.from((capEls.guide || {}).childNodes || [])
        .map((el) => el.getAttribute("points") || "")
        .filter((s) => s.length > 0),
      defaults: () => { capDefaultRegion(); capUpdateUI(); return capRegion(); },
      /* Build a region pointed at exactly what the camera sees, and compare
       * its projection with the dome's own. They must be the same matrix.
       *
       * This is the handedness check. basis() uses r = f x u, so a region
       * must use u = r x c; built the other way the right-vector is negated
       * and every capture comes out mirrored — which a star field will not
       * show you, and which no self-consistent geometric assertion can catch
       * because capCorners would be flipped in the same direction. */
      matchViewMatrix: () => {
        const b = basis();
        const rect = canvas.getBoundingClientRect();
        const aspect = (rect.width / rect.height) || 1;
        const hh = cam.fov * DEG / 2;
        const hw = Math.atan(Math.tan(hh) * aspect);
        const A = capVP({ c: b.f, r: b.r, u: b.u, hw, hh });
        const B = viewProj(aspect);
        let maxDiff = 0;
        for (let i = 0; i < 16; i++) {
          maxDiff = Math.max(maxDiff, Math.abs(A[i] - B[i]));
        }
        return { maxDiff };
      },
      region: () => {
        const r = capRegion();
        if (!r) return null;
        const inside = capFramesIn(r);
        return {
          centre: r.c.slice(), right: r.r.slice(), up: r.u.slice(),
          widthDeg: 2 * r.hw / DEG, heightDeg: 2 * r.hh / DEG,
          corners: capCorners(r),
          frames: inside.gathered.map((i) => shots[i].path),
        };
      },
      /* Which handle, if any, a press at these client coordinates grabs.
       * 0 means the capture does not claim the press and the dome pans as
       * usual — the property that makes the sky draggable in capture mode,
       * and the one that broke when a press on empty sky started a new
       * rectangle instead. */
      /* The tier each gathered frame WOULD be rendered from, as
       * "wanted/available". A capture must resolve the same detail however
       * far out the view is, so this must not move with cam.fov. */
      plannedTiers: () => {
        const r = capRegion();
        if (!r) return null;
        const [W] = capOutputSize(r, capFramesIn(r).gathered);
        const ppd = W / (2 * r.hw / DEG);
        return capFramesIn(r).gathered
          .map((i) => `${capTierFor(shots[i], ppd)}/${shots[i].maxLevel}`);
      },
      handleAt: (x, y) => capHandleAt(x, y),
      screenOf: (d) => screenAt(d),
      /* Does a press at these coordinates BELONG to the capture?
       *
       * This asks capPointerDown, not the hit test, because the decision is
       * what matters: returning true for a press on empty sky is what made
       * the dome impossible to look around in — and a test that only checked
       * capHandleAt passed straight through that, since the hit test was
       * right and the decision was not. Restores the state it probes. */
      wouldClaim: (x, y) => {
        const keep = [capP1, capP2, capP3, capDragHandle];
        const claimed = capPointerDown({ clientX: x, clientY: y });
        capP1 = keep[0]; capP2 = keep[1]; capP3 = keep[2];
        capDragHandle = keep[3];
        return claimed;
      },
      snap: () => capSnap(),
      clear: () => capClear(),
      made: () => capMade.map((c) => ({
        id: c.id, name: c.name, w: c.w, h: c.h, frames: c.frames,
        widthDeg: c.wDeg, heightDeg: c.hDeg, url: c.url,
      })),
    },
    /* Extra names the search should match, as { objId: [alias, ...] }.
     * The map itself only carries an id and a catalogue name; the album
     * holds the aliases, so it hands them over rather than the dome
     * fetching and parsing the catalogue a second time. */
    setAliases: (m) => { aliases = m || {}; },
    /* The catalogue for the object circles. Handed over by gallery.js,
     * which has already merged catalog.json and openngc.json — the dome
     * does not fetch a second copy. Positions arrive in DEGREES. */
    setCatalog: (list) => setCatalog(list),
    /* What the circles would draw right now. Exists so the annotation can
     * be checked from a console or a harness instead of by squinting. */
    objectsInView: () => visibleObjects().map((o) => ({
      id: o.id, name: o.n, type: o.t,
      radiusArcmin: +(o.rad / DEG * 60).toFixed(2),
    })),
    /* Point the view at a sky position directly. goTo() only reaches places
     * that have a PHOTOGRAPH — it looks the id up in `shots` — so there is
     * otherwise no way to look at sky nobody has imaged, which includes the
     * galactic centre: the nearest frame to Sgr A* is 7.1 degrees away. */
    lookAt: (raDeg, decDeg, fovDeg, rollDeg) => {
      cancelFlight();
      cam.pitch = Math.max(-89.5 * DEG, Math.min(89.5 * DEG, decDeg * DEG));
      cam.yaw = raDeg * DEG;
      if (typeof fovDeg === "number") cam.fov = clampFov(fovDeg);
      if (typeof rollDeg === "number") cam.roll = rollDeg * DEG;
      schedule(); updateHud(); refineSoon(0);
      return { yaw: cam.yaw, pitch: cam.pitch, fov: cam.fov, roll: cam.roll };
    },
    /* Where the galactic centre marker is drawn, and how big the ring is
     * for the current field. Exposed because "a green ring appeared" and
     * "the ring is on Sgr A*" are different claims. */
    galacticCentre: () => ({
      ra: SGR_A.ra, dec: SGR_A.dec,
      dir: markerDir(SGR_A),
      ringRadiusDeg: Math.max(0.02, cam.fov * MARKER_SCREEN_FRAC),
    }),
    /* The opening flight, as numbers.
     *
     * Exposed because "the frames move" and "the frames travel from a
     * random place on the sky to the right one" are different claims, and
     * only the first is visible. uSpin is a rotation matrix assembled by
     * hand into column-major order, and one carrying a transposed sign, a
     * scale or a skew would still look like motion on screen — while
     * leaving every photograph a little bit wrong about the sky once it
     * stopped.
     *
     * `start` is where the frame is being drawn right now: the spin
     * applied to its real direction. At the beginning of the flight that
     * is its random starting point, at the end it is home.
     *
     * Copied out, because the matrix comes from a buffer the next shot
     * overwrites. */
    openingFlight: () => {
      const now = performance.now();
      return {
        active: introActive(),
        durationMs: INTRO_MS,
        // Frames drawn anywhere but home right now, by any wave.
        notHome: shots.filter((s) => introSpin(s, now) !== IDENT3).length,
        // The opening wave only: frames queued or in flight.
        shots: shots.filter((s) => s.anim && s.anim.wave === "open").map((s) => {
          const m = introSpin(s, now);
          const c = s.centre;
          return {
            id: s.objId, path: s.path, state: s.anim.state,
            centre: c.slice(),
            spin: Array.from(m),
            start: [m[0] * c[0] + m[3] * c[1] + m[6] * c[2],
                    m[1] * c[0] + m[4] * c[1] + m[7] * c[2],
                    m[2] * c[0] + m[5] * c[1] + m[8] * c[2]],
            // Where it sets off from, and the axis the journey turns about.
            // With them a caller can check the frame travels the great
            // circle between there and home, rather than having to catch it
            // at a known instant.
            from: s.anim.from.slice(),
            travelDeg: s.anim.ang / DEG,
            axis: s.anim.axis.slice(),
            durMs: s.anim.dur,
          };
        }),
      };
    },
    /* The arrivals, as numbers: what is moving, what is waiting, the caps,
     * and the busiest tick since the last reset. `arrivals` counts how many
     * times each frame has begun an animation since the page loaded, which
     * is what "each frame animates in once" is checked against. reset=true
     * zeroes the peaks after reading them. */
    animation: (reset) => {
      const r = {
        live: [...animLive].map((s) => ({ path: s.path, wave: s.anim.wave,
                                          kind: s.anim.kind })),
        queued: animQueue.length,
        hidden: shots.filter((s) => s.arrived === false).length,
        max: ANIM_MAX, startsPerTick: ANIM_STARTS_PER_TICK,
        marginFrac: ANIM_MARGIN, travelMaxDeg: ANIM_TRAVEL_MAX_DEG,
        tapRadii: TAP_RADII, tapMax: TAP_MAX,
        peakLive: animPeakLive, peakStarts: animPeakStarts,
        arrivals: shots.map((s) => [s.path, s.arrivals || 0]),
      };
      if (reset) { animPeakLive = 0; animPeakStarts = 0; }
      return r;
    },
    beginOpeningFlight: () => { introBegin(); schedule(); return introActive(); },
    endOpeningFlight: () => { introStop(); return introActive(); },
    /* Every reference ring, with where it points. Exposed so a marker can be
     * checked against what it claims to mark rather than against the constant
     * it was built from. */
    /* The detail-texture budget eviction works against, in bytes. Exposed
     * so a test asserts the budget the code actually has rather than a
     * number copied out of it years ago: tests/dome_harness.js carried a
     * 160 MB constant while this was 512 MB, and passed for as long as the
     * album was small enough never to reach either. At 293 frames it
     * reported a failure that was the test being stale. */
    detailBudget: () => DETAIL_BUDGET,
    markers: () => activeMarkers().map((m) => ({
      label: m.label, kind: m.kind, ra: m.ra, dec: m.dec, dir: markerDir(m),
    })),
    showMarkers: (on) => (on === undefined ? markersOn : setMarkers(on)),
    brightness: (v) => (v === undefined ? domeGain : setGain(v, true)),
    gainNow: () => liveGain(),        // what the composite is drawn with right now (the seam holds 1.0)
    menu: (on) => (on === undefined ? menuOpen : setMenu(on)),
    /* The object-circle toggle, readable and settable. Its state is a
     * per-viewer preference in localStorage, so this is the only way a
     * harness can turn it on — and turning it on is the only way to
     * exercise the annotation at all. */
    // NOT `circles` — that name is already taken below by the three
    // great circles (equator, ecliptic, galactic), and shadowing it
    // silently broke that member.
    objectCircles: (on) => (on === undefined ? circlesOn : setCircles(on)),
    /* Which photograph a click on this object would open, and why.
     * Exposed because "it took me to the wrong one" is otherwise
     * unfalsifiable. */
    photoFor: (id) => {
      if (!imagedReady) computeImaged();
      const o = catalogue.find((x) => x.id === id);
      if (!o || !o.inShots || !o.inShots.length) return null;
      const i = bestShotFor(o);
      return {
        id: o.id,
        candidates: o.inShots.map((k) => ({
          path: shots[k].path,
          integrationS: Number(shots[k].integrationS) || 0,
        })).sort((a, b) => b.integrationS - a.integrationS),
        opens: shots[i].path,
        opensIntegrationS: Number(shots[i].integrationS) || 0,
      };
    },
    /* How much of the handed-over catalogue is actually IN a photograph.
     * The gap between this and the catalogue size is the coverage filter;
     * the gap between this and what draws is the on-screen culling. Saying
     * which of the two is responsible is otherwise guesswork. */
    catalogueStats: () => {
      if (!imagedReady) computeImaged();
      const imaged = catalogue.filter((o) => o.imaged);
      return {
        handed: catalogue.length,
        imaged: imaged.length,
        frames: shots.filter((s) => !s.bg).length,
        sample: imaged.slice(0, 8).map((o) => o.id),
      };
    },
    /* What is NAMED right now, as opposed to merely circled. The two
     * differ by the spacing and cap rules, and that difference is the
     * whole question when someone says a circle has no name. */
    labelsInView: () => {
      const layer = document.getElementById("dome-obj-labels");
      const out = [];
      for (const el of (layer ? layer.children : [])) {
        if (el.style && el.style.display !== "none" && el.textContent) {
          out.push(el.textContent);
        }
      }
      return out;
    },
    /* The pole of each reference great circle. A great circle IS its
     * pole, so this is the whole definition of where each one lies. */
    circles: () => {
      const out = {};
      for (const c of CIRCLES) out[c.key] = circlePole(c);
      return out;
    },
    /* Swing to a target by object id — the same motion a search does. */
    goTo: (objId) => {
      const i = shots.findIndex((s) => s.objId === objId);
      if (i < 0) return false;
      flyTo(shots[i]);
      return true;
    },
    /* Swing to one PHOTOGRAPH, by its published path.
     *
     * goTo() takes an object id and lands on whichever of that target's
     * frames happens to be first in `shots`. For a target photographed once
     * that is the same thing; for M 31, photographed four times at three
     * different pointings, it is not, and "show me where this picture is"
     * has to mean this picture.
     *
     * Returns false rather than guessing when the path is not on the map —
     * the caller knows what else to try, and the map deliberately holds
     * stacks only, so the conditioned half of every pair is absent. */
    goToPath: (path) => {
      const i = shots.findIndex((s) => s.path === path);
      if (i < 0) return false;
      flyTo(shots[i]);
      // Arriving from a picture in the album, the whole question is "which
      // of these plates is the one I was looking at?" — so answer it.
      highlightShot(shots[i]);
      return true;
    },
    /* Which paths the map actually holds. Lets a caller decide what to ask
     * for before asking, instead of calling goToPath in a loop and watching
     * the camera for whether it worked. */
    hasPath: (path) => shots.some((s) => s.path === path),
    /* Load the map (once) so hasPath can answer before the dome is open — the
     * album's flight must choose a frame the dome holds BEFORE it measures. */
    ready: () => ensure(),
    // Where the camera is pointing and how wide the field is. A copy, so
    // reading it cannot move the view. Exists so the state that is
    // otherwise only visible as pixels can be checked from a console or a
    // test harness.
    camera: () => ({ yaw: cam.yaw, pitch: cam.pitch, fov: cam.fov, roll: cam.roll,
                     fovMin: fovMin(), fovMax: FOV_MAX, fovSharp }),
    /* The pure hand-off maths, exposed for the flight and for a node test. */
    wcsHandoff: (w) => wcsHandoff(w),
    wcsRoundTripPx: (w) => wcsRoundTripPx(w),
    rollToPole: (pole, yawDeg, pitchDeg) => rollToPole(pole, yawDeg * DEG, pitchDeg * DEG),
    dragStep: (yaw, pitch, roll, dx, dy, perPx) => dragStep(yaw, pitch, roll, dx, dy, perPx),
    flightFov: (k) => flightFov(k),
    fovMin: () => FOV_MIN, fovDefault: () => FOV_DEFAULT,
    fovArrive: () => FOV_ARRIVE,
    fovHandoff: () => FOV_HANDOFF,
    handoffFovUsed: () => handoffFov,
    /* Have a frame's detail tier RESIDENT before the flight arrives on it.
     *
     * The album's zoom-in takes FLIGHT_MS; nothing used to ask the dome for the
     * tier until enterFlight(), so the hand-off drew tier 0 (256 px, ~15x
     * upscaled at 1.5 deg) while 2048 downloaded — "blurry the second you enter".
     * Called from the hover warm-up and at the start of flyToDome, this gets the
     * fetch a full second's head start. Loads the map first if the dome has never
     * been opened. */
    prefetchFor: async (path, fovDeg) => {
      try {
        if (!(await ensure())) return false;
        const i = shots.findIndex((x) => x.path === path);
        if (i < 0) return false;
        const s = shots[i];
        const fov = (isFinite(fovDeg) && fovDeg > 0) ? fovDeg : FOV_HANDOFF;
        loadBase(s);
        const want = capTierFor(s, surfaceH() / fov);
        if (want > s.detailLevel) loadDetail(s, want);
        return true;
      } catch (e) { return false; }
    },
    /* Is the tier the hand-off needs already resident? (test/diagnostic) */
    tierReadyFor: (path, fovDeg) => {
      const i = shots.findIndex((x) => x.path === path);
      if (i < 0) return null;
      const s = shots[i];
      const want = capTierFor(s, surfaceH() / ((isFinite(fovDeg) && fovDeg > 0) ? fovDeg : FOV_HANDOFF));
      return { want, have: s.detailLevel, max: s.maxLevel, ready: s.detailLevel >= want || s.detailLevel >= s.maxLevel };
    },
    /* Ground truth for verification: where THIS renderer puts a sky point, in
     * client pixels, computed from the same basis() and the same canvas box that
     * dirAt() uses for picking — so it is the exact inverse of the dome's own
     * pointer mapping, not a re-derivation. Returns null if the point is behind
     * the camera. Test affordance; nothing in the product calls it. */
    screenOf: (raDeg, decDeg) => {
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      const ra = raDeg * DEG, dec = decDeg * DEG, cd = Math.cos(dec);
      const d = [cd * Math.cos(ra), cd * Math.sin(ra), Math.sin(dec)];
      const { f, r, u } = basis();
      const df = d[0] * f[0] + d[1] * f[1] + d[2] * f[2];
      if (df <= 1e-9) return null;
      const x = (d[0] * r[0] + d[1] * r[1] + d[2] * r[2]) / df;
      const y = (d[0] * u[0] + d[1] * u[1] + d[2] * u[2]) / df;
      const t = Math.tan(cam.fov * DEG / 2);
      const aspect = rect.width / rect.height;
      const ndcX = x / (t * aspect), ndcY = y / t;
      return { x: rect.left + (ndcX + 1) / 2 * rect.width,
               y: rect.top + (1 - ndcY) / 2 * rect.height };
    },
    /* The twin of screenOf: the sky under a client pixel, via the dome's own
     * dirAt(). Test affordance. */
    skyAt: (clientX, clientY) => {
      if (!canvas) return null;
      const d = dirAt(clientX, clientY);
      return { raDeg: Math.atan2(d[1], d[0]) / DEG,
               decDeg: Math.asin(Math.max(-1, Math.min(1, d[2]))) / DEG };
    },
    canvasRect: () => {
      if (!canvas) return null;
      const r = canvas.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    },
    /* Test affordance — see debugHoldMs. */
    debugHoldArrival: (ms) => { debugHoldMs = Math.max(0, Number(ms) || 0); },
    /* Set the arrival rotation by hand to find the right one by eye; pass null to
     * return to the value computed from the WCS. Read it back with no argument. */
    arrivalTurn: (deg) => {
      if (deg === undefined) return turnOverride;
      turnOverride = (deg === null) ? null : Number(deg);
      return turnOverride;
    },
    /* Everything that went into the last arrival, for diagnosing a mismatch
     * without having to read the source. */
    lastArrival: () => lastArrival,
    /* The shot's own angular height in degrees, so the album can work out the
     * zoom that makes its picture subtend exactly FOV_HANDOFF at the hand-off. */
    shotFovDeg: (p) => {
      const i = shots.findIndex((x) => x.path === p);
      return i < 0 ? null : wcsHandoff(shots[i].wcs).fovDeg;
    },
    /* Both angular extents of a shot. The album needs whichever one runs
     * VERTICALLY on screen, and that depends on whether it has turned the
     * picture — a portrait frame laid on its side shows its WIDTH vertically.
     * Using the height regardless zoomed the album 1.78x too far (measured,
     * uniform across the album), which left the centre matching while the stars
     * diverged from it. */
    /* The frame's plate scale in DEGREES PER IMAGE PIXEL. The album uses this to
     * work out its own degrees-per-screen-pixel from the image it is actually
     * rendering, and then asks for a matching dome field — so the two agree by
     * construction instead of by my arithmetic about total extents, which only
     * holds to first order and assumes the layout is exactly what I think. */
    shotPlateScaleDeg: (p) => {
      const i = shots.findIndex((x) => x.path === p);
      return i < 0 ? null : wcsHandoff(shots[i].wcs).scaleArcsecPx / 3600;
    },
    shotAngularSize: (p) => {
      const i = shots.findIndex((x) => x.path === p);
      if (i < 0) return null;
      const h = wcsHandoff(shots[i].wcs);
      return { heightDeg: h.fovDeg, widthDeg: h.widthDeg };
    },
    /* The arrival rotation: the shot's own +y direction, and the camera roll
     * that puts it up (plus the album's quarter turn for portrait sources). */
    shotUpDir: (w) => shotUpDir(w),
    rollForShot: (w, turnDeg) => rollForShot(w, turnDeg),
    alignEngaged: () => alignEngaged,
    domeCanvasSize: () => domeCanvasSize(),
    /* The N↔S alignment control: which frame is "up", and how it is set. */
    alignment: (idx) => (idx === undefined
      ? { key: ALIGNMENTS[alignIdx].key, label: ALIGNMENTS[alignIdx].label, roll: cam.roll }
      : setAlignment(idx)),
    /* Point the view at a photograph and hold the yellow region rectangle.
     * The flight arrives zoomed IN at the shot's own angular size and eases
     * out to the usual fit, so the hand-off is seamless with the album. */
    /* Forward BOTH arguments. This wrapper took only `path` and silently dropped
     * the album's rotation, so the arrival was always unrolled no matter what the
     * caller computed — the dome looked "not rotated at all". A thin wrapper that
     * narrows its own signature is an easy thing to miss: the call site was right,
     * the value was right, and it vanished at the boundary. */
    /* Every argument, by name. A wrapper that forwards fewer than the function
     * takes drops the rest silently — this one lost the file solve, so the
     * flight aimed at the original's centre on every cropped frame. */
    enterFlight: (path, albumRotDeg, arriveFovDeg, pedestal, fileWcs) =>
      enterFlight(path, albumRotDeg, arriveFovDeg, pedestal, fileWcs),
    /* diagnostics */
    flightPedestal: () => ({ idx: flightShotIdx, now: flightPedestal, full: flightPedestalFull, blend: flightBlend }),
    exitFlight: (path, done, opts) => exitFlight(path, done, opts),
    /* The blend weight a frame with this much integration gets where it
     * overlaps another. Exposed so the claim that overlaps combine the way
     * stacking does — weight proportional to integration time — can be
     * checked rather than asserted in a comment. */
    weightFor: (integrationS, half) => depthWeight(integrationS, half !== false),
    // The overlap graph the transparency is built from, and the same
    // inside-a-footprint test the fragment shader runs — exposed so the
    // matrix form can be checked against a plain trigonometric one rather
    // than only against itself.
    overlaps: () => (ensureOverlaps(), {
      slots: ovlSlots,
      nbrs: shots.map((s) => s.nbrs.slice()),
      inside: (dir, i) => insideProj(dir, shots[i]),
    }),
  };
})();
