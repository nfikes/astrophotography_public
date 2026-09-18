/*  Public astrophotography gallery — slideshow + searchable grid.
 *
 *  Deliberately excluded (vs the private observing tool):
 *    • lat/lon, GPS, altitude/azimuth, weather, time, moon phase
 *    • recipe/hyperparameter cards, image stats card, capture EXIF
 *    • rescan, cloud map, JPL Horizons, ASTAP-on-demand
 *
 *  Uses only pre-generated JSON: catalog.json, openngc.json,
 *  photos.json, photo_callouts.json, astap_cache.json. All loaded at
 *  boot; no server-side endpoints called.
 */

const $ = (sel, root = document) => root.querySelector(sel);

// ── i18n ────────────────────────────────────────────────────────────
// Minimal EN/JA translation layer. Only translates the visible chrome and
// Image cache-buster. Bumped whenever conditioned photos are
// regenerated so browsers (and GitHub Pages' CDN) don't keep serving
// stale copies — the JS/CSS have `?v=NN` in the HTML, but image files
// keep their unversioned URLs, so we append this at render time.
const IMG_VER = "47bd13bc";
const vURL = (p) => `${p}?v=${IMG_VER}`;

/* `photos/M31_2.jpg` → `thumbs/M31_2.jpg`, the 400px copy publish.py writes
 * beside every published photograph.
 *
 * The grid tile is a 190px square and used to load the full 1600px picture
 * to fill it — 29 MB to scroll an album of 200. This is a pure rename with
 * no manifest, matching publish.thumb_rel(), and the <img> keeps an onerror
 * fallback to the full-size original so a missing thumbnail degrades to
 * slow rather than to a broken-image glyph. */
const thumbURL = (p) => (typeof p === "string" && p.startsWith("photos/"))
  ? "thumbs/" + p.slice("photos/".length)
  : p;

// astronomy type labels — proper nouns (M31, NGC 5195, Trifid Nebula) and
// constellation abbreviations (UMa) stay in Latin, matching astronomical
// convention where object names are locale-agnostic.
const I18N = {
  en: {
    title: "Astrophotography",
    searchPlaceholder: "Search: M31, Andromeda, Nebula, Galaxy…",
    countJoiner: " of ",
    pipelineNotice: "The image pipelines for Galaxy, Nebula and Cluster photos are being improved — please be patient as images increase in quality over time.",
    footer: 'Deep-sky data from <a href="https://github.com/mattiaverga/OpenNGC" target="_blank" rel="noopener">OpenNGC</a> (CC-BY-SA 4.0)',
    disclaimer: "Disclaimer: Images have been reduced to KB from their MB sources for distribution purposes.",
    langLabel: "EN",
    changelogLabel: "Changelog",
    domeLabel: "Sky",
    showcaseTitle: "Integration time",
    showcaseAchieved: "requested — achieved",
    showcaseFrames: "frames",
    domeTitle: "Sky dome — see the album mapped onto the sky",
    domeHint: "Drag to look around · scroll to zoom · click a frame to open it",
    changelogTypes: { website: "Website", photos: "Photos" },
    // Changelog timeline chrome. `{n}` is substituted with the entry count.
    changelogCurrent: "Now",
    changelogCount: "{n} updates",
    changelogCountOne: "{n} update",
    changelogMonths: ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                      "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
    pairLabels: { before: "Raw", after: "Conditioned" },
    compareRibbon: "BEFORE / AFTER",
    conditionedRibbon: "CONDITIONED",
    conditionedInfoTitle: "About this conditioned photo",
    conditionedInfoBullets: [
      "Stacked in Siril as CFA drizzle — the colour pattern is kept through registration instead of being interpolated first, which is what stops noise clumping.",
      "Every frame dark-subtracted, rejected on roundness and star size, and registered onto one pinned reference so the framing never drifts between nights.",
      "Light pollution and cloud removed by GraXpert's AI background model.",
      "Colour calibrated against a star catalogue, then colour noise smoothed on its own — chroma only, so no detail is spent on it.",
      "Stretched with a shadow-protected curve: linear below a pivot just above the sky, so the gain goes to the subject rather than the background.",
      "Stars separated from nebulosity by StarNet and given nothing harsher than a soft blur — any threshold on a star leaves an edge in its profile.",
      "One tone curve rather than six overlapping ones, then the sky set to a fixed level and noise balanced across the frame.",
      "Where one curve cannot serve both — a core bright enough to go flat under the curve the faint outer cloud needs — the picture is rendered twice and the two are mixed per pixel by how bright each region is."
    ],
    seestarInfoTitle: "About this Seestar-enhanced photo",
    seestarInfoBody: "This image was generated on the ZWO Seestar S30 Pro by the smart telescope's built-in AI enhancement — the app's one-tap 'Enhance' step that stacks, denoises, and stretches the frame in place. No local post-processing was applied.",
    noteTitle: "Author's note",
    inFrameLabel: "In frame:",
    addCircles: "Add Circles",
    // The four modes, as they read on the wide buttons under the image
    // and in the grid card's tooltip.
    modes: {
      raw:         "RAW STACK",
      showcase:    "INTEGRATION SHOWCASE",
      conditioned: "CONDITIONED",
      compare:     "BEFORE AND AFTER",
    },
    frameStepLabel: "Frame",
    newBarLabel: "New",
    // "{n} images" on a card that stands for more than one photograph, and
    // "#3 of 4" on the slide. Worded "images", never "views": a badge
    // reading "4 views" on a public page reads as a visit counter.
    imagesLabel: "{n} images",
    viewOfLabel: "#{n} of {t}",
    // Section headings. Keys are the output of canonicalType(), so a new
    // catalogue string cannot land without a heading — it falls to "other".
    sections: {
      family: "Family Photos",
      galaxy: "Galaxies", nebula: "Nebulae", planetary: "Planetary Nebulae",
      remnant: "Supernova Remnants", cluster: "Clusters",
      globular: "Globular Clusters", star: "Stars", solar: "Solar System",
      field: "Sky Fields", other: "Other",
    },
    /* Family photos. `{h}` is the integration floor, read from
     * data/families.json rather than written here, so the rule and the
     * sentence describing it cannot drift apart.
     *
     * ONE sentence, and "usually" is load-bearing. A reader needs two facts
     * — several subjects, a long exposure — and the three-sentence version
     * spent a paragraph on the album's own bookkeeping to deliver them.
     *
     * "usually" is what lets it be a single sentence at all. A flat "{h} or
     * more" is false over the hand-declared families that sit below the
     * floor (M 31 + M 110 at 2 h 11 m), which is why the old text needed a
     * second sentence to take the exception back. Hedging the rule once
     * covers every such card without spending another sentence on it. */
    familyNote: "One photograph, more than one subject — usually {h} or more of integration.",
    familyRibbon: "FAMILY PHOTO",
    familyBadge: "FAMILY",
    familyMembersLabel: "In this family:",
    familyAlsoLabel: "Also in a family photo:",
    familyOpenHint: "Open the family photo",
    familyMemberHint: "Open {name} on its own",
    showAllLabel: "Show all {t}",
    starLabel: "Add to starred",
    unstarLabel: "Remove from starred",
    filtersLabel: "Filters",
    allConstellations: "All constellations",
    fConditioned: "Conditioned",
    fDeep: "30 min+",
    fStarred: "★ Starred",
    fClear: "Clear",
    slideshowStart: "Play slideshow",
    slideshowStop: "Stop slideshow",
    units: { h: "h", min: "min", s: "s" },
    types: {},  // English is source-of-truth; no remapping needed.
    ids: {},
    names: {},
  },
  ja: {
    title: "天体写真アルバム",
    searchPlaceholder: "検索: M31、アンドロメダ、星雲、銀河…",
    countJoiner: " / ",
    pipelineNotice: "銀河・星雲・星団の画像処理パイプラインは現在改良中です。今後画質が向上していきますので、少しお待ちください。",
    footer: '深宇宙データ: <a href="https://github.com/mattiaverga/OpenNGC" target="_blank" rel="noopener">OpenNGC</a> より (CC-BY-SA 4.0)',
    disclaimer: "免責事項: 配信のため、元のMBサイズからKBに縮小されています。",
    langLabel: "日本語",
    changelogLabel: "更新履歴",
    domeLabel: "天球",
    showcaseTitle: "露出時間の比較",
    showcaseAchieved: "を目標 — 実際は",
    showcaseFrames: "コマ",
    domeTitle: "天球ドーム — アルバムを空にマッピング",
    domeHint: "ドラッグで見回す · スクロールで拡大 · 写真をクリックで開く",
    changelogTypes: { website: "サイト", photos: "写真" },
    changelogCurrent: "最新",
    changelogCount: "更新 {n} 件",
    changelogCountOne: "更新 {n} 件",
    changelogMonths: ["1月", "2月", "3月", "4月", "5月", "6月",
                      "7月", "8月", "9月", "10月", "11月", "12月"],
    pairLabels: { before: "元画像", after: "調整済み" },
    compareRibbon: "元画像 / 調整済み",
    conditionedRibbon: "調整済み",
    conditionedInfoTitle: "この調整済み写真について",
    conditionedInfoBullets: [
      "SirilでCFAドリズル合成。先にデモザイクせず、色配列を保ったまま位置合わせします。ノイズの塗りつぶしを防ぎます。",
      "全フレームをダーク補正し、真円度と星像サイズで選別。基準フレームを固定し、夜をまたいでも構図がずれません。",
      "光害と雲を、GraXpertのAI背景モデルで除去。",
      "星カタログを基準に色調補正し、色ノイズだけを平滑化。輝度の細部は失いません。",
      "暗部を守るトーンカーブでストレッチ。空のすぐ上までは直線のままで、背景ではなく対象に階調を使います。",
      "StarNetで星と星雲を分離し、星には緩やかなぼかし以上の処理をしません。しきい値処理は星の輪郭を残すためです。",
      "複数の調整を重ねず、トーンカーブは1本だけ。その後空の明るさを揃え、画面全体でノイズを均一化します。",
      "1本では足りない場合 — 淡い外周に合わせると中心部が平坦になってしまう対象 — は、画像を2通り現像し、領域の明るさに応じて画素ごとに混ぜます。"
    ],
    seestarInfoTitle: "Seestarで強調処理された写真について",
    seestarInfoBody: "この画像はZWO Seestar S30 Proのスマート望遠鏡が内蔵するAIエンハンス機能（アプリのワンタップ「エンハンス」）で生成されたものです。スタック・ノイズ除去・ストレッチをその場で行っています。ローカルでの後処理は行っていません。",
    noteTitle: "撮影メモ",
    inFrameLabel: "画角内:",
    addCircles: "すべて丸で示す",
    modes: {
      raw:         "スタック原版",
      showcase:    "露出時間の比較",
      conditioned: "現像済み",
      compare:     "ビフォー / アフター",
    },
    frameStepLabel: "コマ",
    newBarLabel: "新着",
    imagesLabel: "{n}枚",
    viewOfLabel: "{t}枚中 #{n}",
    sections: {
      family: "ファミリー写真",
      galaxy: "銀河", nebula: "星雲", planetary: "惑星状星雲",
      remnant: "超新星残骸", cluster: "星団", globular: "球状星団",
      star: "恒星", solar: "太陽系", field: "天域", other: "その他",
    },
    // One sentence, and 「通常」 carries the same hedge as the English
    // "usually": the hand-declared families below the floor must not make
    // it false.
    familyNote: "1枚の写真に、主役が2つ以上 — 露出時間は通常{h}以上です。",
    familyRibbon: "ファミリー写真",
    familyBadge: "ファミリー",
    familyMembersLabel: "この写真の主役:",
    familyAlsoLabel: "ファミリー写真にも登場:",
    familyOpenHint: "ファミリー写真を開く",
    familyMemberHint: "{name}を単独で開く",
    showAllLabel: "全{t}件を表示",
    starLabel: "お気に入りに追加",
    unstarLabel: "お気に入りから削除",
    filtersLabel: "絞り込み",
    allConstellations: "すべての星座",
    fConditioned: "調整済み",
    fDeep: "30分以上",
    fStarred: "★ お気に入り",
    fClear: "クリア",
    slideshowStart: "スライドショー再生",
    slideshowStop: "スライドショー停止",
    units: { h: "時間", min: "分", s: "秒" },
    types: {
      "Galaxy": "銀河",
      "Open Cluster": "散開星団",
      "Constellation": "星座",
      "Globular Cluster": "球状星団",
      "Emission Nebula": "輝線星雲",
      "Planetary Nebula": "惑星状星雲",
      "Reflection Nebula": "反射星雲",
      "Planet": "惑星",
      "Supernova Remnant": "超新星残骸",
      "Galaxy Pair": "銀河ペア",
      "Star": "恒星",
      "Star Cloud": "星雲",
      "Double Star": "二重星",
      "Asterism": "星群",
      "Dark Nebula": "暗黒星雲",
      "Moon": "月",
      "Emission/Reflection Nebula": "輝線・反射星雲",
      "Open Cluster + Nebula": "散開星団＋星雲",
      "Dwarf Planet": "準惑星",
      // Not an object type but a statement about a photograph; it reaches
      // tType() the same way, so it is translated the same way.
      "Family photo": "ファミリー写真",
    },
    // The `ids` map is intentionally narrow: only for objects whose "id"
    // is a common noun (Moon, Sun, planets, named stars). Catalog IDs
    // (M31, NGC 5195, IC 1318) stay Latin per astronomical convention.
    ids: {
      "Moon": "月",
      "Sun": "太陽",
      "Mercury": "水星",
      "Venus": "金星",
      "Mars": "火星",
      "Jupiter": "木星",
      "Saturn": "土星",
      "Uranus": "天王星",
      "Neptune": "海王星",
      "Pluto": "冥王星",
      "Ceres": "ケレス",
      "Vega": "ベガ",
      "Arcturus": "アークトゥルス",
      "Polaris": "ポラリス",
      "Thuban": "トゥバン",
    },
    names: {
      // Solar system + named-star common names — mirror the ids so both
      // the purple id chip AND the white name text translate together.
      "Moon": "月",
      "Sun": "太陽",
      "Mercury": "水星",
      "Venus": "金星",
      "Mars": "火星",
      "Jupiter": "木星",
      "Saturn": "土星",
      "Uranus": "天王星",
      "Neptune": "海王星",
      "Pluto": "冥王星",
      "Ceres": "ケレス",
      "Vega": "ベガ",
      "Arcturus": "アークトゥルス",
      "Polaris": "ポラリス",
      "Thuban": "トゥバン",
      // Deep-sky common names.
      "Trifid Nebula": "三裂星雲",
      "Andromeda Galaxy": "アンドロメダ銀河",
      "Hercules Globular Cluster": "ヘルクレス座球状星団",
      "Whirlpool Galaxy": "子持ち銀河",
      "Pinwheel Galaxy": "回転花火銀河",
      "Owl Nebula": "ふくろう星雲",
      "Ring Nebula": "環状星雲",
      "North America Nebula": "北アメリカ星雲",
      "Spindle Galaxy": "紡錘状銀河",
      "Splinter Galaxy": "スプリンター銀河",
      "Dumbbell Nebula": "亜鈴状星雲",
      "Bubble Nebula": "バブル星雲",
      "Butterfly Nebula (Sadr Region)": "はくちょう座γ星星雲（サドル領域）",
      "Bode's Galaxy": "ボーデ銀河",
      "Crescent Nebula": "三日月星雲",
      "Western Veil Nebula": "西の網状星雲",
      "Wizard Nebula": "ウィザード星雲",
      "Lagoon Nebula": "干潟星雲",
      "Eagle Nebula": "わし星雲",
      "Omega Nebula": "オメガ星雲",
      "Cigar Galaxy": "葉巻銀河",
      "Pelican Nebula": "ペリカン星雲",
      // Family titles. These come from data/families.json, reach the
      // screen through tName() exactly as an object name does, and so are
      // translated in the same table. A family with no entry here shows
      // its English title, which is the same graceful fallback every
      // untranslated object name already gets.
      "Lagoon Nebula & Trifid Nebula": "干潟星雲と三裂星雲",
      "Andromeda Galaxy & M110": "アンドロメダ銀河とM110",
      // Constellations (as they appear in the `objConstellation` field
      // AND when a constellation photo's objName is the constellation).
      "Ursa Major": "おおぐま座",
      "Ursa Minor": "こぐま座",
      "Sagittarius": "いて座",
      "Andromeda": "アンドロメダ座",
      "Lyra": "こと座",
      "Hercules": "ヘルクレス座",
      "Canes Venatici": "りょうけん座",
      "Cygnus": "はくちょう座",
      "Draco": "りゅう座",
      "Serpens": "へび座",
      "Cepheus": "ケフェウス座",
      "Boötes": "うしかい座",
      "Coma Berenices": "かみのけ座",
      "Vulpecula": "こぎつね座",
      "Cassiopeia": "カシオペヤ座",
      "Sagitta": "や座",
    },
  },
};
/* Browser storage, guarded.
 *
 * A browser set to block site data does not return null from localStorage —
 * it THROWS SecurityError on the property access itself. This read is at
 * module scope, so an unguarded throw here kills the script before `main` is
 * even defined: no gallery, no error, a blank page. The same applies to the
 * write, where a private window can throw QuotaExceededError.
 *
 * Every future key goes through these two, for the same reason. */
function lsGet(key) {
  try { return localStorage.getItem(key); } catch (e) { return null; }
}
function lsSet(key, value) {
  try { localStorage.setItem(key, value); return true; } catch (e) { return false; }
}
let LANG = (lsGet("astrogallery.lang") === "ja") ? "ja" : "en";
function tType(t) {
  if (!t) return "";
  const table = I18N[LANG].types;
  if (table[t]) return table[t];
  // "Star (K0III)", "Eclipsing binary (B7Ve)" — translate the prefix if we
  // know it, keep the spectral class parenthetical intact.
  if (LANG === "ja") {
    if (t.startsWith("Star ")) return t.replace(/^Star /, "恒星 ");
    if (t.startsWith("Eclipsing binary")) return t.replace("Eclipsing binary", "食連星");
  }
  return t;
}
function tUnit(u) { return I18N[LANG].units[u] || u; }
function tId(id)   { return (I18N[LANG].ids   || {})[id]   || id; }
function tName(nm) { return (I18N[LANG].names || {})[nm]   || nm; }

// ── State ───────────────────────────────────────────────────────────
let CATALOG = null;
let PHOTOS  = { byObject: {}, generated: null };
let ASTAP_CACHE = {};
let PHOTO_CALLOUTS = { byPath: {} };
let NOTES = { byObjId: {} };
let SCREENSHOTS = { byObjId: {} };
// Integration-time showcases. Keyed byObjId; only targets past the
// promotion bar (1 h) have an entry. Each step is the SAME target at a
// different exposure depth, with identical processing at every step.
let SHOWCASE = { byObjId: {} };
let _scItem = null;
let _scIndex = 0;
// Per-photo notes and option rows, keyed by path. notes.json is keyed
// byObjId, so every photo of an object shared one note — which breaks as
// soon as an object has two genuinely different captures. Saturn is the
// clear case: a 6x10 s stack that blew the planet out completely, and a
// 914-frame video stack that resolved the rings. One sentence cannot
// describe both. A per-path note wins over the per-object one.
//
// `downloads` is likewise declared per photo rather than inferred. The old
// rule paired a conditioned image with whatever raw shared its capture
// date, which silently dropped the before/after slider whenever a frame
// was re-conditioned later than its source — M31, M81, M63 and NGC 6960
// had all lost theirs.
let PHOTO_OPTIONS = { byPath: {} };
/* Family photos, from data/families.json.
 *
 * The album files every photograph under one target, chosen from the
 * filename, and that is right until the integration gets long. A ten-hour
 * frame holding both the Lagoon and the Trifid is not a Lagoon photograph
 * with a passenger in it — both are subjects, and a reader who searched for
 * the Trifid was being handed a card labelled "M 8 — Lagoon Nebula" with
 * nothing on it to say why.
 *
 * So such a photograph GRADUATES: it leaves its filename's target and
 * becomes a family, a target of its own with its own card, its own section
 * and every member's name in its search haystack. The member it left keeps
 * a link back, so the depth is re-attributed rather than lost.
 *
 * `byPath` maps a published photograph to a family id; `families` describes
 * each one. Written by tools/build_families.py, which owns the rule (4 h of
 * integration and two bodies each at least 8% of the frame's short edge);
 * nothing here re-derives it, so the site and the tool cannot disagree
 * about what a family is.
 */
let FAMILIES = { families: {}, byPath: {}, rule: {} };
let CHANGELOG = { entries: [] };
// data/version.json, kept whole rather than read once into the hero: the
// changelog panel stamps the same number at its head, and both want the
// one source of truth.
let VERSION = null;
// Which era bands are expanded, by major number. Null until the first
// render decides (newest era open, the rest collapsed); held outside
// renderChangelog so a language flip re-renders without folding the
// panel back up under the reader.
let CLOG_OPEN = null;
let CLOG_OPEN_ITEMS = new Set();
// Local state for the screenshot lightbox — which target is showing
// and which shot index within its list is currently on-screen.
let _ssItem = null;
let _ssIndex = 0;
// Object ids from the most recent photo drop. The grid puts these first
// and draws a thin separator bar under them so returning visitors can
// spot what's new at a glance. Update whenever a new batch ships (there
// should be a matching changelog "photos" entry the same day). The
// previous batch is not re-listed — the separator only ever demarks the
// single freshest drop; older "new" items graduate into the main grid.
const NEW_OBJECT_IDS = [
  // New arrivals 2026-09-14 .. 2026-09-20 (the calendar week, Mon-Sun). Newest first.
  // Generated: tools/deposit_inventory.py --new-band
  // 2026-09-18
  "NGC6960",    // 4 image(s) in the album
  // 2026-09-17
  "IC1287",     // 2 image(s) in the album
  "V379Vul",    // 1 image(s) in the album
  "NGC6624",    // 1 image(s) in the album
  // 2026-09-16
  "Moon",       // 14 image(s) in the album
  // 2026-09-15
  "NGC6604",    // 5 image(s) in the album
];
// Precomputed per-photo lists of in-frame catalog bodies. Keyed by
// item.path. Populated lazily on first access from ASTAP_CACHE + CATALOG.
// Reused by both the chip UI and the search predicate.
const IN_FRAME_CACHE = new Map();

/* The four ways of looking at one target, in the order the buttons show.
 * `colour` is the mode's identity: it tints the button that selects it and
 * it is one slice of the split border on the target's grid card, so a card
 * says at a glance which of the four it carries.
 *
 * RAW has no colour of its own — it is the plain photograph everything
 * else is derived from, and giving it one would imply it had been done to
 * rather than simply taken. */
const MODES = [
  { id: "raw",         colour: "var(--mode-raw)" },
  { id: "showcase",    colour: "var(--mode-showcase)" },
  { id: "conditioned", colour: "var(--mode-conditioned)" },
  { id: "compare",     colour: "var(--mode-compare)" },
];
const MODE_IDS = MODES.map(m => m.id);

const state = {
  items: [],        // flat list of {path, filename, objId, objName, ...}
  index: 0,         // index into items — the photograph currently on screen
  subjects: [],     // one entry per target, holding up to four modes
  subject: 0,       // index into subjects
  mode: "raw",
  frame: {},        // per-mode position, for modes holding several frames
  // A capture the viewer framed themselves, shown in the big frame at the
  // top. Not a subject: it has no objId, no catalogue entry, no modes and no
  // pair, and threading one through buildSubjects() would put it into the
  // grid, the search index and the counts, all of which assume every subject
  // is a catalogue object. So the slide painter takes it as a separate state
  // and returns early, and anything that navigates clears it.
  viewingCapture: null,
  scIndex: 0,       // nearest milestone, for the ticks and the readout
  // Continuous position along the milestone ladder. The slider used to be
  // integer-stepped, so it CUT between stacks; a fractional position lets
  // the next stack fade in over the current one and the picture visibly
  // deepens instead of jumping.
  scPos: 0,
  filtered: [],     // subset shown in the grid
  // What the arrows and the counter walk. Set by gridRenderPlan, so
  // filtering to galaxies and pressing right stays among galaxies instead of
  // wandering into an open cluster. Includes subjects hidden by a collapsed
  // section or a page cap — folding a section away is DISPLAY; the query and
  // the filter row are INTENT, and only intent narrows navigation.
  view: [],
  // The target's durable identity. state.subject is a position, and a
  // keystroke that re-filters the grid moves every position; without this,
  // typing a character would slide the viewer onto a different object.
  subjectId: null,
};

// ── Boot ────────────────────────────────────────────────────────────
async function loadData() {
  const [cat, openngc, photos, callouts, astap, notes, screenshots, photoOptions, changelog, showcase, version, families] = await Promise.all([
    // Guarded like every sibling below. This was the one fetch in the set
    // with neither an .ok check nor a .catch, so a single dropped request
    // rejected the whole Promise.all, rejected main() (which awaits
    // loadData() OUTSIDE its try), and left the visitor a hero image over an
    // empty grid with no message and no recovery. An empty catalog renders a
    // thin album; an exception renders nothing at all.
    fetch("data/catalog.json").then(r => r.ok ? r.json() : { objects: [] })
      .catch(() => ({ objects: [] })),
    fetch("data/openngc.json").then(r => r.ok ? r.json() : null).catch(() => null),
    fetch("data/photos.json").then(r => r.ok ? r.json() : { byObject: {} }).catch(() => ({ byObject: {} })),
    fetch("data/photo_callouts.json").then(r => r.ok ? r.json() : null).catch(() => null),
    fetch("data/astap_cache.json").then(r => r.ok ? r.json() : {}).catch(() => ({})),
    fetch("data/notes.json").then(r => r.ok ? r.json() : { byObjId: {} }).catch(() => ({ byObjId: {} })),
    fetch("data/screenshots.json").then(r => r.ok ? r.json() : { byObjId: {} }).catch(() => ({ byObjId: {} })),
    fetch("data/photo_options.json").then(r => r.ok ? r.json() : { byPath: {} }).catch(() => ({ byPath: {} })),
    fetch("changelog.json").then(r => r.ok ? r.json() : { entries: [] }).catch(() => ({ entries: [] })),
    fetch("data/showcase.json").then(r => r.ok ? r.json() : { byObjId: {} }).catch(() => ({ byObjId: {} })),
    fetch("data/version.json").then(r => r.ok ? r.json() : null).catch(() => null),
    fetch("data/families.json").then(r => r.ok ? r.json() : null).catch(() => null),
  ]);
  CATALOG = cat;
  PHOTOS = photos;
  ASTAP_CACHE = astap || {};
  if (callouts && callouts.byPath) PHOTO_CALLOUTS = callouts;
  NOTES = (notes && notes.byObjId) ? notes : { byObjId: {} };
  SCREENSHOTS = (screenshots && screenshots.byObjId) ? screenshots : { byObjId: {} };
  SHOWCASE = (showcase && showcase.byObjId) ? showcase : { byObjId: {} };
  VERSION = version || null;
  // Painted once here rather than in applyLanguage: a version number is
  // the same in every language.
  if (version && version.version) {
    const el = $("#hero-version");
    if (el) el.textContent = `Version ${version.version}`;
  }
  PHOTO_OPTIONS = (photoOptions && photoOptions.byPath) ? photoOptions : { byPath: {} };
  // Guarded the same way, and for the same reason: an album with no
  // families.json is an album with no family photos, not a broken one.
  FAMILIES = (families && families.byPath && families.families)
    ? { families: families.families, byPath: families.byPath,
        rule: families.rule || {} }
    : { families: {}, byPath: {}, rule: {} };
  CHANGELOG = changelog && Array.isArray(changelog.entries)
    ? changelog
    : { entries: [] };
  // Merge OpenNGC extras onto the curated catalog so majAxisArcmin +
  // type + constellation are available for callouts + search.
  if (openngc && Array.isArray(openngc.objects)) mergeOpenNgc(openngc.objects);
}

function mergeOpenNgc(extras) {
  const byKey = new Map();
  for (const o of CATALOG.objects) {
    byKey.set(o.id, o);
    for (const a of (o.aliases || [])) byKey.set(a, o);
  }
  for (const e of extras) {
    const existing = byKey.get(e.id);
    if (existing) {
      const set = new Set([...(existing.aliases || []), ...(e.aliases || []), e.id]);
      set.delete(existing.id);
      existing.aliases = [...set];
      if (!existing.name || existing.name === existing.id) existing.name = e.name;
      if (typeof e.ra === "number") existing.ra = e.ra;
      if (typeof e.dec === "number") existing.dec = e.dec;
      if (typeof e.magnitude === "number") existing.magnitude = e.magnitude;
      /* OpenNGC's type wins where the two agree about what KIND of thing
       * this is, because its vocabulary is richer — "Star (F7Ib
       * supergiant)" rather than "Star". Where they disagree about the
       * kind, the album's own catalogue wins, because a disagreement that
       * large means the id matched a DIFFERENT OBJECT.
       *
       * IC 1318 is the case that found this. The album has it as the
       * Butterfly Nebula, an emission nebula in Cygnus; OpenNGC resolves
       * the same id to gam Cyg — Sadr, the star sitting in front of it —
       * typed "*". The merge took the star's type and filed the nebula
       * under Star, where nobody looking for a nebula would find it.
       *
       * Compared by section rather than by string so this only fires on a
       * real disagreement: "Emission Nebula" and "HII Region" are the same
       * kind of thing and either may win. */
      if (e.type && (!existing.type
                     || canonicalType(e.type) === canonicalType(existing.type))) {
        existing.type = e.type;
      }
      if (e.constellation) existing.constellation = e.constellation;
      if (typeof e.majAxisArcmin === "number") existing.majAxisArcmin = e.majAxisArcmin;
      if (typeof e.minAxisArcmin === "number") existing.minAxisArcmin = e.minAxisArcmin;
    } else {
      CATALOG.objects.push(e);
    }
  }
}

// Flatten PHOTOS.byObject into a linear list. Each entry gets its target
// object's name + type for search.
//
// Pair-mode: a photo whose device is "conditioned" and which has a
// "raw" sibling (same objId, same date) is folded into a single item
// with `pair = { rawPath, condPath }`. The raw sibling is dropped from
// the list so pairs occupy one grid tile, not two.
function buildItems() {
  const items = [];
  for (const [objId, photos] of Object.entries(PHOTOS.byObject || {})) {
    const obj = CATALOG.objects.find(o => o.id === objId);
    if (!obj) continue;
    // Build pair index per object: date → {raw, conditioned}
    const pairIndex = new Map();
    for (const p of photos) {
      if (!p.date) continue;
      const dev = (p.device || "").toLowerCase();
      if (dev !== "raw" && dev !== "conditioned") continue;
      const bucket = pairIndex.get(p.date) || {};
      bucket[dev] = p;
      pairIndex.set(p.date, bucket);
    }
    // Track raw photos consumed into pairs so we don't emit them separately
    const rawConsumed = new Set();
    for (const bucket of pairIndex.values()) {
      if (bucket.raw && bucket.conditioned) rawConsumed.add(bucket.raw.path);
    }
    // Same for pairs declared in photo_options.json. Without this the raw
    // would render both as its own tile and inside the compare slider.
    for (const p of photos) {
      if ((p.device || "").toLowerCase() !== "conditioned") continue;
      const dl = ((PHOTO_OPTIONS.byPath || {})[p.path] || {}).downloads;
      if (Array.isArray(dl) && dl.length === 2 && dl[0].path !== p.path) {
        rawConsumed.add(dl[0].path);
      }
    }
    for (const p of photos) {
      if (p.isNearby) continue;
      // The raw member of a registered pair is NO LONGER dropped. It used
      // to be, because it would otherwise have appeared in the grid both
      // as its own tile and inside its conditioned sibling's compare
      // slider. The grid is one card per target now, so there is nothing
      // to duplicate — and that raw stack is exactly what the RAW STACK
      // mode is meant to show.
      const consumed = rawConsumed.has(p.path);
      const dev = (p.device || "").toLowerCase();
      // publish.py may inject `pair` at scrub time (needs source dates,
      // which the public JSON drops). If it did, use that; else compute
      // client-side from device+date. Both branches produce identical
      // `{ rawPath, condPath }` shape.
      let pair = p.pair || null;
      // A declared two-button option row IS a raw/conditioned pair, so the
      // compare slider comes from the same source as the download buttons.
      // Deriving them separately is how they drifted apart: the buttons
      // would say there is a raw while the slider, matching on date alone,
      // decided there wasn't.
      if (!pair && dev === "conditioned") {
        const dl = ((PHOTO_OPTIONS.byPath || {})[p.path] || {}).downloads;
        if (Array.isArray(dl) && dl.length === 2 && dl[0].path && dl[1].path) {
          pair = { rawPath: dl[0].path, condPath: dl[1].path };
        }
      }
      if (!pair && dev === "conditioned" && p.date) {
        const bucket = pairIndex.get(p.date);
        if (bucket && bucket.raw) {
          pair = { rawPath: bucket.raw.path, condPath: p.path };
        }
      }
      items.push({
        pairMember: consumed,   // the raw half of a compare; RAW-mode material
        path: p.path,
        filename: p.filename,
        isNew: !!p.isNew,       // set by publish.py for the newest drop; lets
                                // the separator work per-photo instead of
                                // promoting an object's whole back catalogue
        exif: p.exif || null,
        device: dev || null,
        conditionedBy: p.conditionedBy || null,   // "custom" | "seestar" | null
        objId,
        objName: obj.name,
        objType: obj.type,
        objConstellation: obj.constellation,
        obj,
        pair,       // { rawPath, condPath } or null (raw/conditioned compare)
        exposurePair: p.exposurePair || null,     // { shortPath, longPath, shortExpS, longExpS } or null
        // Stable per-object view number from data/view_index.json, assigned
        // once at ingest and never reused. NOT this photograph's position in
        // any list: a new picture of M 31 must not renumber the old ones, or
        // "#3" printed on a card would mean a different photograph next
        // month. Absent only for a photograph the index has not seen yet.
        view: (typeof p.view === "number") ? p.view : null,
        isMaster: !!p.master,
      });
    }
  }
  // Dedupe by path (a photo can appear under multiple aliases).
  const seen = new Set();
  return items.filter(it => {
    if (seen.has(it.path)) return false;
    seen.add(it.path);
    return true;
  });
}

// ── Subjects ────────────────────────────────────────────────────────
/* One entry per target, holding every photograph of it sorted into the
 * four modes. The grid used to be one tile per photograph, which put M 31
 * in it eight times and the Moon ten; a viewer scrolling for targets had
 * to scroll past the same target over and over.
 *
 * A photograph can serve two modes at once: the conditioned half of a
 * registered pair is both the CONDITIONED image and the right-hand side
 * of the BEFORE/AFTER, and it is listed under both.
 */
/* How many distinct photographs this card stands for.
 *
 * Counted by PATH, not by list length: a registered pair's conditioned half
 * is listed under both `conditioned` and `compare`, so summing the modes
 * would report four images for two.
 */
function imageCount(subj) {
  return new Set(MODE_IDS.flatMap(k => subj.modes[k] || [])
    .map(it => it && it.path).filter(Boolean)).size;
}

/* The highest view number this object has, which is what "of N" must count
 * against — not imageCount(). A retired photograph leaves a gap, so an
 * object whose views are 1, 2 and 4 has three images but its last is #4,
 * and "#4 of 3" would read as a bug. */
function viewMax(subj) {
  const ns = MODE_IDS.flatMap(k => subj.modes[k] || [])
    .map(it => it && it.view).filter(n => typeof n === "number");
  return ns.length ? Math.max(...ns) : 0;
}

function totalExposure(it) {
  const s = it.exif && it.exif.exposure_s;
  return typeof s === "number" && isFinite(s) ? s : -1;
}

/* The type string a family carries. Never used to decide the section —
 * canonicalType keys off `obj.isFamily`, so this is free to be prose — but
 * it is what the slide prints under the name, so it reads as a sentence
 * fragment rather than as a taxonomy key. */
const FAMILY_TYPE = "Family photo";

/* The family a photograph belongs to, or null.
 *
 * `byPath` is the authority and `families` is only the description, and
 * this is the single place that knows it. */
function familyOf(item) {
  const id = (FAMILIES.byPath || {})[item && item.path];
  const rec = id ? (FAMILIES.families || {})[id] : null;
  return rec ? { ...rec, id } : null;
}

/* A family, shaped like any other subject so every renderer downstream —
 * the card, the mode row, the filmstrip, the star button — works on it
 * without knowing what it is.
 *
 * The constellation is filled in only when every member agrees. A family
 * spanning two of them genuinely has none, and inheriting the first
 * member's would put it under a heading it does not belong to and hide it
 * from the one it does. */
function familySubject(fam) {
  /* A member with no catalogue entry still counts as a member.
   *
   * Dropping it would be the quiet kind of wrong: the title would go on
   * naming it while the search haystack, the member chips and the
   * new-arrivals lookup all stopped knowing about it, so the card would
   * say "Eagle Nebula & Omega Nebula" and not answer a search for one of
   * them. A stub keeps the id searchable and the count honest. */
  const members = (fam.members || []).map(id =>
    (CATALOG.objects || []).find(o => o.id === id) || { id, name: id });
  const cons = [...new Set(members.map(o => o.constellation).filter(Boolean))];
  const title = fam.title || fam.id;
  const obj = {
    id: fam.id, name: title, type: FAMILY_TYPE, catalog: "Families",
    isFamily: true, members: members.map(o => o.id),
  };
  return {
    objId: fam.id, objName: title, objType: FAMILY_TYPE,
    objConstellation: cons.length === 1 ? cons[0] : null,
    obj, isFamily: true, family: fam, members,
    isNew: false, modes: {},
  };
}

function buildSubjects(items) {
  const byObj = new Map();
  const add = (s, mode, it) => { (s.modes[mode] = s.modes[mode] || []).push(it); };
  for (const it of items) {
    /* A family photograph is filed under the FAMILY and not under the
     * target its filename happened to name. It graduates rather than being
     * copied: shipping it in both places would put the same picture on the
     * screen twice, once labelled "M 8" and once labelled "Lagoon & Trifid",
     * and a grid of one card per target would be quietly telling a lie
     * about how many photographs are behind it.
     *
     * What the member loses is re-attributed, not dropped: below, every
     * member gets a link back to the family carrying its integration time,
     * so M 8's card still says where its deepest frame went. */
    const fam = familyOf(it);
    const key = fam ? fam.id : it.objId;
    let s = byObj.get(key);
    if (!s) {
      s = fam ? familySubject(fam) : {
        objId: it.objId, objName: it.objName, objType: it.objType,
        objConstellation: it.objConstellation, obj: it.obj,
        isNew: false, modes: {},
      };
      byObj.set(key, s);
    }
    s.isNew = s.isNew || !!it.isNew;
    // Compare needs a REGISTERED pair. publish.py ORB-aligns the two
    // members so the divider does not make the target jump as it crosses;
    // pairing an arbitrary stack with an arbitrary conditioned frame would
    // put an unregistered slider on screen and call it a comparison.
    if (it.pair || it.exposurePair) add(s, "compare", it);
    if (it.device === "conditioned") add(s, "conditioned", it);
    else add(s, "raw", it);
  }
  const subjects = [];
  for (const s of byObj.values()) {
    // "The RAW Stack is the highest integration on disk" — deepest first,
    // so the mode opens on it and the stepper walks back through the rest
    // rather than making the deepest one something you have to hunt for.
    for (const k of ["raw", "conditioned", "compare"]) {
      if (s.modes[k]) s.modes[k].sort((a, b) => totalExposure(b) - totalExposure(a));
    }
    const sc = (SHOWCASE.byObjId || {})[s.objId];
    if (sc && sc.steps && sc.steps.length) s.showcase = sc;
    s.available = MODE_IDS.filter(
      m => m === "showcase" ? !!s.showcase : (s.modes[m] || []).length > 0);
    if (!s.available.length) continue;
    /* Which photograph this target opens on, and previews with: the one
     * carrying the most integration time, whichever mode holds it.
     *
     * It used to be conditioned-first, on the grounds that the conditioned
     * frame looks like what the target looked like. But the card already
     * prints the deepest integration this target has, and that number was
     * routinely describing a photograph the card was not showing and the
     * click did not open. One target, one headline frame, and the number
     * under it is now the number for the picture above it.
     *
     * Compare is excluded from the choice: its members are already in raw
     * or conditioned (an item is added to compare AND to its own device
     * list), so it cannot hold anything deeper, and opening on a slider
     * would answer "show me the deepest photograph" with a comparison. */
    let deepMode = null, deepExp = -Infinity;
    for (const k of ["conditioned", "raw"]) {
      const l = s.modes[k];
      if (!l || !l.length) continue;
      // Sorted deepest-first just above, so [0] is this mode's deepest.
      const e = totalExposure(l[0]);
      if (e > deepExp) { deepExp = e; deepMode = k; }
    }
    // Falls back the old way for a target that has neither — compare-only,
    // or showcase-only, where there is no integration to rank.
    s.deepMode = deepMode;
    const cover = (deepMode ? s.modes[deepMode][0] : null)
               || (s.modes.conditioned || [])[0] || (s.modes.raw || [])[0]
               || (s.modes.compare || [])[0];
    s.cover = cover ? cover.path : null;
    s.coverItem = cover || null;
    subjects.push(s);
  }
  linkFamilies(subjects);
  return subjects;
}

/* Wire each family to its members and back.
 *
 * Done as a second pass rather than inside the loop above because a family
 * and its members are built in whatever order their photographs happen to
 * appear in, and the link has to be able to point at a subject that does
 * not exist yet.
 *
 * A member with no card of its own — every photograph it has went to the
 * family — simply gets no back-link, and the family is the only place it
 * lives. That is the honest outcome and needs no special case: there is
 * nothing to link back TO.
 */
function linkFamilies(subjects) {
  const byId = new Map(subjects.map(s => [s.objId, s]));
  for (const fam of subjects) {
    if (!fam.isFamily) continue;
    fam.memberSubjects = [];
    for (const m of fam.members) {
      const solo = byId.get(m.id);
      if (!solo) continue;
      fam.memberSubjects.push(solo);
      (solo.families = solo.families || []).push(fam);
    }
  }
}

/* How much integration a family's deepest photograph carries, and how that
 * compares with the album's ordinary ones.
 *
 * This exists because the site makes a claim — that family photos run
 * deeper than the rest — and a claim about the data should be read off the
 * data. Returns null when there is nothing to compare against, or when the
 * comparison does not actually hold, so the copy can fall back to the
 * plain statement rather than print a fabricated multiple.
 */
function familyDepthComparison(subjects) {
  const depthsOf = (list) => list
    .map(s => subjectDeepest(s)).filter(v => v > 0).sort((a, b) => a - b);
  const median = (a) => a.length
    ? (a.length % 2 ? a[(a.length - 1) / 2]
                    : (a[a.length / 2 - 1] + a[a.length / 2]) / 2)
    : 0;
  const fam = depthsOf(subjects.filter(s => s.isFamily));
  const rest = depthsOf(subjects.filter(s => !s.isFamily));
  if (!fam.length || !rest.length) return null;
  const mf = median(fam), mr = median(rest);
  if (!(mf > mr) || mr <= 0) return null;
  return { familyMedian: mf, otherMedian: mr, ratio: mf / mr };
}

/* The photograph a given subject+mode+position resolves to. Showcase has
 * no item of its own — its milestone stacks are not in photos.json — so it
 * borrows the subject's deepest raw stack, which is the same pointing and
 * the same target and therefore the right thing to answer "what is in this
 * frame" and "whose note is this" with. */
function modeItem(subj, mode) {
  if (!subj) return null;
  if (mode === "showcase") return (subj.modes.raw || [])[0]
                               || (subj.modes.conditioned || [])[0] || null;
  const list = subj.modes[mode] || [];
  if (!list.length) return null;
  const i = Math.max(0, Math.min(state.frame[mode] || 0, list.length - 1));
  return list[i];
}

/* The list navigation walks. Falls back to every subject before the first
 * render, because main() calls showSubject(0) before applyLanguage() builds
 * the grid — getting that order wrong breaks the "a broken first paint still
 * leaves the header wired" regression check. */
function navList() {
  return (state.view && state.view.length) ? state.view : state.subjects;
}
function currentSubject() { return navList()[state.subject] || null; }

/* ── Voting ───────────────────────────────────────────────────────────────
 *
 * "Which of these would you like to see reprocessed?" — a wishlist the album
 * can actually read, rather than a guess.
 *
 * The gallery is static on GitHub Pages, so the count lives in a small
 * Cloudflare Worker (public_gallery/vote_worker/). Until that Worker exists
 * VOTE_ENDPOINT is empty and NOTHING is rendered: no button, no request, no
 * failed fetch in the console. Setting the URL is the only step needed to
 * turn it on.
 *
 * Two independent layers of state, deliberately:
 *   - the SHARED count, from the Worker;
 *   - whether THIS browser has voted, in localStorage, exactly as the ☆ star
 *     button already does. That is what makes the pressed state instant and
 *     survive a reload, and it means a viewer who has never voted sees a
 *     correct button before the network answers.
 *
 * If the Worker is unreachable the button hides itself. A dead endpoint must
 * never turn into a broken page — this is the least important control here.
 */
const VOTE_ENDPOINT = "";   // e.g. "https://astro-votes.<sub>.workers.dev"
const VOTE_KEY = "astrogallery.voted";
let VOTE_TALLY = null;      // objId -> count, once fetched

function votedSet() {
  try { return new Set(JSON.parse(lsGet(VOTE_KEY) || "[]")); }
  catch (e) { return new Set(); }
}
function markVoted(id) {
  const s = votedSet();
  s.add(id);
  lsSet(VOTE_KEY, JSON.stringify([...s]));
}

async function loadTally() {
  if (!VOTE_ENDPOINT) return null;
  try {
    const r = await fetch(`${VOTE_ENDPOINT}/tally`, { cache: "no-store" });
    const j = await r.json();
    VOTE_TALLY = (j && j.ok) ? (j.tally || {}) : null;
  } catch (e) {
    VOTE_TALLY = null;      // stays hidden; see the note above
  }
  return VOTE_TALLY;
}

function paintVote() {
  const btn = document.getElementById("slide-vote");
  if (!btn) return;
  const item = (typeof currentItem === "function") ? currentItem() : null;
  const id = item && item.objId;
  if (!VOTE_ENDPOINT || !VOTE_TALLY || !id) { btn.hidden = true; return; }
  btn.hidden = false;
  const mine = votedSet().has(id);
  btn.setAttribute("aria-pressed", mine ? "true" : "false");
  btn.disabled = mine;
  btn.dataset.objid = id;
  const n = Number(VOTE_TALLY[id] || 0);
  const out = document.getElementById("slide-vote-n");
  if (out) out.textContent = n ? String(n) : "";
  btn.title = mine
    ? "You have voted for this one"
    : "Vote for this one to be reprocessed";
}

function wireVote() {
  const btn = document.getElementById("slide-vote");
  if (!btn || !VOTE_ENDPOINT) return;
  btn.addEventListener("click", async () => {
    const id = btn.dataset.objid;
    if (!id || btn.disabled) return;
    // Optimistic: mark it locally first so the control answers immediately.
    // The count is a shared number and can be corrected by the response; the
    // pressed state is this browser's own and does not need the network.
    markVoted(id);
    btn.disabled = true;
    btn.setAttribute("aria-pressed", "true");
    try {
      const r = await fetch(`${VOTE_ENDPOINT}/vote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const j = await r.json();
      if (j && j.ok) {
        VOTE_TALLY = VOTE_TALLY || {};
        VOTE_TALLY[id] = j.count;
      }
    } catch (e) { /* the local mark stands; the count catches up next load */ }
    paintVote();
  });
  loadTally().then(paintVote);
}

function currentItem() { return modeItem(currentSubject(), state.mode); }

/* Paths to try when flying the dome to a photograph, best first.
 *
 * The slide's own frame is what was asked for, so it leads. But the sky map
 * carries stacks only — publish.py leaves every pipeline-conditioned frame
 * off it, 36 of them — and the conditioned half is what most slides show.
 * Its raw partner is the same pointing on the same night, so it answers
 * "where is this" exactly, and is second. After that, any other photograph
 * of the same target: a different pointing, but the right part of the sky,
 * which still beats not moving.
 *
 * Deduplicated, because a pair contributes its raw path from two of these
 * rules and trying it twice would be two failed lookups, not one. */
function domePathsFor(item) {
  if (!item) return [];
  const out = [];
  const add = (p) => { if (p && !out.includes(p)) out.push(p); };
  add(item.path);
  if (item.pair) add(item.pair.rawPath);
  if (item.exposurePair) {
    add(item.exposurePair.longPath);
    add(item.exposurePair.shortPath);
  }
  const subj = (state.subjects || []).find((s) => s.objId === item.objId);
  if (subj) {
    for (const k of MODE_IDS) for (const it of (subj.modes[k] || [])) add(it.path);
  }
  return out;
}

/* Does the album know where this photograph is?
 *
 * Asked of the plate solves rather than of the dome, because the dome has
 * not fetched its map yet when the slide is painted — it costs nothing
 * until its button is pressed, and making a button's visibility depend on
 * it would undo that. ASTAP_CACHE is already loaded here and is the same
 * source the sky map is built from.
 *
 * 19 photographs have no solve. For those the button is hidden rather than
 * shown and made inert: opening the dome and then sitting still is a worse
 * answer than not offering. */
function hasSkyPlace(item) {
  return domePathsFor(item).some((p) => {
    const r = ASTAP_CACHE[p] && ASTAP_CACHE[p].result;
    return !!(r && r.solved);
  });
}

// ── Slideshow ───────────────────────────────────────────────────────
// Compact camera-settings line for the slide caption. Everything shown
// here survived publish.py's EXIF whitelist — no timestamps, no GPS.
function formatExposure(sec) {
  if (typeof sec !== "number" || !isFinite(sec) || sec <= 0) return null;
  if (sec >= 3600) {
    const h = sec / 3600;
    return `${h % 1 === 0 ? h.toFixed(0) : h.toFixed(1)} ${tUnit("h")}`;
  }
  if (sec >= 60) {
    const m = sec / 60;
    return `${m % 1 === 0 ? m.toFixed(0) : m.toFixed(1)} ${tUnit("min")}`;
  }
  if (sec >= 1) return `${sec % 1 === 0 ? sec.toFixed(0) : sec.toFixed(1)} ${tUnit("s")}`;
  return `1/${Math.round(1 / sec)} ${tUnit("s")}`;
}
function slideStatsHtml(exif) {
  if (!exif) return "";
  const parts = [];
  const exp = formatExposure(exif.exposure_s);
  if (exp) parts.push(`<span>${escapeHtml(exp)}</span>`);
  if (exif.f_number)  parts.push(`<span>f/${escapeHtml(String(exif.f_number))}</span>`);
  if (exif.focal_mm)  parts.push(`<span>${escapeHtml(String(exif.focal_mm))} mm</span>`);
  if (exif.iso)       parts.push(`<span>ISO ${escapeHtml(String(exif.iso))}</span>`);
  const cam = [exif.make, exif.model].filter(Boolean).join(" ");
  if (cam)            parts.push(`<span class="cam">${escapeHtml(cam)}</span>`);
  return parts.join('<span class="sep">·</span>');
}

/* The slider that lives over the image in showcase mode. Ticks are placed
 * by POSITION, not by minutes: the milestones are 1, 10, 30, 60, 120, and
 * spacing them by value would crush the first three against the left edge
 * where they are the most interesting part of the sequence. */
function renderShowcaseScrub(subj, steps) {
  const range = $("#slide-sc-range");
  const ticks = $("#slide-sc-ticks");
  const read  = $("#slide-sc-read");
  if (!range) return;
  range.max = String(Math.max(0, steps.length - 1));
  range.value = String(state.scPos);
  if (ticks && ticks.dataset.n !== String(steps.length)) {
    ticks.dataset.n = String(steps.length);
    ticks.innerHTML = steps.map((s, i) => {
      const pct = steps.length > 1 ? (i / (steps.length - 1)) * 100 : 50;
      return `<span class="sc-scrub-tick" style="left:${pct.toFixed(3)}%">` +
             `<b>${escapeHtml(fmtMinutes(scStepMin(steps, i)))}</b></span>`;
    }).join("");
  }
  const last = steps.length - 1;
  const i0 = Math.max(0, Math.min(Math.floor(state.scPos), last));
  const i1 = Math.min(i0 + 1, last);
  const frac = i1 > i0 ? state.scPos - i0 : 0;
  const cur = steps[state.scIndex];
  if (read && cur) {
    if (frac > 0.001) {
      // Mid-dissolve. Say what is on screen — a fade BETWEEN two real
      // stacks — and never a single figure: a blend of a 10-min and a
      // 30-min stack averages their noise down further than a true 20-min
      // integration does, so naming it "20 min" would be a false claim
      // about what that much exposure buys, which is the one thing this
      // showcase exists to demonstrate honestly.
      read.innerHTML =
        `<strong>${escapeHtml(fmtMinutes(scStepMin(steps, i0)))}</strong> ` +
        `→ <strong>${escapeHtml(fmtMinutes(scStepMin(steps, i1)))}</strong> · ` +
        `${Math.round(frac * 100)}%`;
    } else {
      // What the stack ACHIEVED, not what was asked for — frames get
      // rejected during registration, so 30 minutes requested is never 30
      // minutes delivered.
      read.innerHTML =
        `<strong>${escapeHtml(fmtMinutes(scStepMin(steps, state.scIndex)))}</strong> · ` +
        `${escapeHtml(I18N[LANG].showcaseAchieved)} ${cur.achieved_min.toFixed(1)} min · ` +
        `${cur.frames} ${escapeHtml(I18N[LANG].showcaseFrames)}`;
    }
  }
  ticks && ticks.querySelectorAll(".sc-scrub-tick").forEach((el, i) => {
    el.classList.toggle("is-on", frac > 0.001 ? (i === i0 || i === i1)
                                              : i === state.scIndex);
  });
  // Warm the neighbours. Dragging the slider should look like the same
  // picture getting deeper, and it cannot if each step blanks while its
  // file downloads — doubly so now that two stacks are on screen at once.
  for (const j of [i0 - 1, i0, i1, i1 + 1]) {
    if (j >= 0 && j < steps.length && typeof Image === "function") {
      new Image().src = vURL(steps[j].path);
    }
  }
}

/* Some modes hold more than one photograph — ten of the Moon, eight of
 * M 31. One card per target must not mean the other nine are unreachable,
 * so the mode carries a stepper and opens on the deepest. */
function renderFrameStep() {
  // Superseded by the filmstrip, which shows the other photographs instead
  // of only counting them. The row is kept rather than deleted because
  // stepFrame() is still the one place a frame change goes through and its
  // two buttons are still wired to it.
  const el = $("#slide-frame-step");
  if (el) el.hidden = true;
}

/* The other photographs of this target, lined up across the top of the
 * preview.
 *
 * The stepper it replaces could reach all eight frames of M 31, but it
 * never said what any of them were: pressing › eight times to find the one
 * you wanted is not a choice, it is a search. Thumbnails make it one look.
 *
 * Scoped to the OPEN mode, which is the same set the stepper walked — the
 * mode row above already decides raw vs conditioned, and folding both into
 * one strip would put two versions of the same photograph side by side with
 * nothing to tell them apart.
 */
function renderStrip() {
  const el = $("#slide-strip");
  if (!el) return;
  const subj = currentSubject();
  const list = (!subj || state.viewingCapture || state.mode === "showcase")
    ? [] : (subj.modes[state.mode] || []);
  if (list.length < 2) {
    el.hidden = true;
    el.innerHTML = "";
    return;
  }
  const at = Math.max(0, Math.min(state.frame[state.mode] || 0, list.length - 1));
  el.hidden = false;
  el.innerHTML = list.map((it, i) => {
    // The stable view number where there is one, so the strip agrees with
    // the "#3 of 4" line below rather than inventing its own numbering.
    const n = typeof it.view === "number" ? it.view : i + 1;
    const exp = formatExposure(totalExposure(it));
    const label = `#${n}${exp ? " · " + exp : ""}`;
    return `<button type="button" class="strip-thumb${i === at ? " is-on" : ""}"`
      + ` data-i="${i}" title="${escapeAttr(label)}"`
      + ` aria-label="${escapeAttr(label)}"`
      + ` aria-current="${i === at ? "true" : "false"}">`
      + `<img loading="lazy" decoding="async" alt=""`
      + ` src="${escapeAttr(vURL(thumbURL(it.path)))}"`
      + ` data-full="${escapeAttr(vURL(it.path))}"`
      + ` onerror="if(this.dataset.full&&this.src!==this.dataset.full)`
      + `{this.src=this.dataset.full;}">`
      + `<span class="strip-n">${escapeHtml(String(n))}</span></button>`;
  }).join("");
  el.querySelectorAll(".strip-thumb").forEach((b) => {
    b.addEventListener("click", () => {
      const i = Number(b.dataset.i) || 0;
      // A hand on the strip is manual navigation, like the arrows are.
      slideshowStop();
      state.frame[state.mode] = i;
      paintSlide();            // repaints the strip, and closes any blow-up
      openBlowup(list[i]);
    });
  });
  // Keep the open frame in sight without moving the PAGE: scrolling this
  // box only, where scrollIntoView would scroll whatever contains it.
  // The strip WRAPS now rather than running off to the right, so the axis
  // that overflows is the vertical one.
  const on = el.querySelector(".strip-thumb.is-on");
  if (on) el.scrollTop = on.offsetTop - (el.clientHeight - on.offsetHeight) / 2;
}

/* One photograph at the full size of the preview, over everything else in
 * the frame, until the × in the corner is pressed.
 *
 * Deliberately bounded by the preview rather than the window: a full-screen
 * lightbox is a different place, and this is meant to be a closer look at
 * the picture already on screen, with the strip it came from still visible
 * underneath.
 */
function blowupOpen() {
  const box = $("#slide-blowup");
  return !!box && !box.hidden;
}

function openBlowup(item) {
  const box = $("#slide-blowup"), img = $("#slide-blowup-img");
  if (!box || !img || !item) return;
  img.src = vURL(item.path);
  img.alt = tName(item.objName || item.objId) || "";
  // Landscape like everywhere else. This was the one view that still showed
  // a Seestar frame standing on end: the slide stage turns its content, the
  // compare slider turns its own box, and the blow-up turned nothing — so
  // pressing a filmstrip thumbnail dropped you from a landscape picture into
  // a portrait one of the same thing.
  const mark = () => box.classList.toggle(
    "is-turned", img.naturalHeight > img.naturalWidth);
  if (img.complete && img.naturalWidth) mark();
  else img.addEventListener("load", mark, { once: true });
  box.hidden = false;
  // The way out has to be reachable from the keyboard, and it is the only
  // control inside the overlay.
  //
  // preventScroll, because focus() scrolls its target into view by default
  // and this button sits at the TOP of the slide frame — so pressing a
  // filmstrip thumbnail yanked the page upward every time. Most visible on
  // a target with many photographs, where the strip is what you are looking
  // at and it jumped out from under the cursor. The option is honoured by
  // every current browser; the fallback keeps focus (and the jump) rather
  // than losing the keyboard exit, which is the worse failure.
  const close = $("#slide-blowup-close");
  if (close && close.focus) {
    try { close.focus({ preventScroll: true }); }
    catch (_) { close.focus(); }
  }
}

function closeBlowup() {
  const box = $("#slide-blowup"), img = $("#slide-blowup-img");
  if (!box || box.hidden) return;
  box.hidden = true;
  // Drop the source, so a large photograph still on its way down stops.
  if (img) img.removeAttribute("src");
}

/* Which photograph of this target is on screen: "#3 of 4".
 *
 * Deliberately NOT the stepper's "2 / 3" above, which counts position within
 * one mode — the third RAW frame and the third photograph of the target are
 * different things, and a viewer comparing two tabs needs the one that does
 * not change when they switch modes. This is the stable view number from
 * data/view_index.json, so it still names the same picture next month.
 *
 * Hidden for a target with one photograph, and for a capture, which has no
 * object and therefore no view number.
 */
function renderViewNumber() {
  const el = $("#slide-view");
  if (!el) return;
  const subj = currentSubject();
  const item = state.items[state.index];
  const total = subj ? viewMax(subj) : 0;
  const n = item && typeof item.view === "number" ? item.view : null;
  if (state.viewingCapture || !subj || !n || total < 2) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.textContent = (I18N[LANG].viewOfLabel || "#{n} of {t}")
    .replace("{n}", String(n)).replace("{t}", String(total));
  el.title = (I18N[LANG].imagesLabel || "{n} images")
    .replace("{n}", String(imageCount(subj)));
}

function stepFrame(delta) {
  state.viewingCapture = null;
  const subj = currentSubject();
  if (!subj) return;
  const list = subj.modes[state.mode] || [];
  if (list.length < 2) return;
  const i = Math.max(0, Math.min(state.frame[state.mode] || 0, list.length - 1));
  state.frame[state.mode] = (i + delta + list.length) % list.length;
  paintSlide();
}

/* Label for one mode button, e.g. "M 31 — INTEGRATION SHOWCASE". */
function modeLabel(subj, mode) {
  const dict = (I18N[LANG].modes || I18N.en.modes || {});
  return `${tId(subj.objId)} ${dict[mode] || mode}`;
}

/* The row of wide buttons under the large image. One per mode the target
 * actually has, in a fixed order so the same mode is always in the same
 * place across targets. */
function renderModeRow() {
  const row = $("#slide-modes");
  const subj = currentSubject();
  if (!row || !subj) return;
  // Cleared by paintCaptureSlide, which hides it outright; showing a real
  // subject has to undo that or the modes never come back.
  row.hidden = false;
  row.innerHTML = "";
  // A single mode is not a choice; the row would be a button that does
  // nothing but restate the caption below it.
  if (subj.available.length < 2) { row.hidden = true; return; }
  row.hidden = false;
  for (const id of subj.available) {
    const def = MODES.find(m => m.id === id);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "slide-mode" + (id === state.mode ? " is-on" : "");
    btn.dataset.mode = id;
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-selected", id === state.mode ? "true" : "false");
    btn.style.setProperty("--mode-colour", def.colour);
    const list = id === "showcase"
      ? (subj.showcase.steps || []) : (subj.modes[id] || []);
    btn.innerHTML = `<span class="slide-mode-label">${escapeHtml(modeLabel(subj, id))}</span>`
      + (list.length > 1
          ? `<span class="slide-mode-count">${list.length}</span>` : "");
    btn.addEventListener("click", () => setMode(id));
    row.appendChild(btn);
  }
}

function setMode(mode) {
  state.viewingCapture = null;
  const subj = currentSubject();
  if (!subj || !subj.available.includes(mode)) return;
  state.mode = mode;
  paintSlide();
}

/* Move to a subject, choosing which mode opens. The mode holding this
 * target's deepest photograph opens first — the same choice the grid card
 * previews with, so clicking a card shows the picture the card showed. */
function showSubject(i, mode) {
  // Leaving the capture view: any move to a real subject drops it, so the
  // painter stops returning early.
  state.viewingCapture = null;
  const list = navList();
  if (!list.length) return;
  state.subject = (i + list.length) % list.length;
  const subj = currentSubject();
  state.subjectId = subj ? subj.objId : null;
  state.frame = {};
  state.scIndex = 0;
  state.scPos = 0;
  const want = mode && subj.available.includes(mode) ? mode : null;
  const deep = subj.deepMode && subj.available.includes(subj.deepMode)
    ? subj.deepMode : null;
  state.mode = want || deep
    || ["conditioned", "raw", "compare", "showcase"].find(m => subj.available.includes(m))
    || subj.available[0];
  paintSlide();
}

/* The family row under the slide headline.
 *
 * One element, two directions, never both at once:
 *
 *   on a family photo   "In this family: M 8  M 20" — each a link to that
 *                       object's own card, which is what makes the deep
 *                       frame a way IN to both targets rather than a place
 *                       one of them disappeared to
 *   on a member         "Also in a family photo: Lagoon & Trifid ⏱ 9.8 h"
 *
 * Hidden otherwise, which is almost every slide. Rebuilt per slide rather
 * than wired once, because the links differ per target and stale ones
 * would silently open the wrong object.
 */
function renderFamilyRow(subj) {
  const row = $("#slide-family");
  const label = $("#slide-family-label");
  const links = $("#slide-family-links");
  if (!row || !label || !links) return;
  const dict = I18N[LANG];
  const pick = (k) => dict[k] || I18N.en[k] || "";
  links.innerHTML = "";

  let targets = [];
  if (subj && subj.isFamily) {
    label.textContent = pick("familyMembersLabel");
    // Only members that HAVE a card of their own. A link to a target with
    // no photographs outside this family would open nothing.
    targets = (subj.memberSubjects || []).map(m => ({
      id: m.objId,
      text: tId(m.objId),
      title: pick("familyMemberHint").replace("{name}", tName(m.objName || m.objId)),
    }));
  } else if (subj && (subj.families || []).length) {
    label.textContent = pick("familyAlsoLabel");
    targets = subj.families.map(f => {
      const d = subjectDeepest(f);
      return {
        id: f.objId,
        text: tName(f.objName) + (d > 0 ? ` ⏱ ${formatExposure(d) || ""}` : ""),
        title: pick("familyOpenHint"),
      };
    });
  }
  if (!targets.length) { row.hidden = true; return; }
  row.hidden = false;
  for (const t of targets) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "slide-family-link";
    btn.textContent = t.text;
    btn.title = t.title;
    btn.addEventListener("click", () => openSubjectById(t.id));
    links.appendChild(btn);
  }
}

/* Open a target by id, from anywhere. Used by the links that run between a
 * family and its members, in both directions.
 *
 * The target may be outside what the grid is currently showing — the link
 * is followed from a card that survived a search the destination did not,
 * and a family and its member rarely match the same query. So a miss
 * clears the query and the filters and looks again rather than reporting
 * that the target does not exist. Scrolls to the slide, because a link
 * that changes something off-screen has visibly done nothing.
 */
function openSubjectById(objId) {
  if (!objId) return false;
  const subj = state.subjects.find(s => s.objId === objId);
  if (!subj) return false;
  slideshowStop();
  let at = navList().indexOf(subj);
  if (at < 0) {
    const box = $("#search");
    if (box) box.value = "";
    clearFilters();
    renderFilters();
    renderGrid();
    at = navList().indexOf(subj);
  }
  showSubject(at >= 0 ? at : 0, null);
  const target = $("#slideshow");
  if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
  else window.scrollTo({ top: 0, behavior: "smooth" });
  return true;
}

// A download button is colored by WHICH variant it fetches, mirroring the
// tile border/ribbon palette so a viewer learns one set of colors:
//   • raw          → neutral gray  (the base stack)
//   • conditioned  → gold          (matches .tile-conditioned)
//   • integration  → cyan          (matches .tile-exposure-pair — the
//                                    deepest / highest-integration stack)
// Classified from the button's title/label AND the slide's item context so
// declared option rows in photo_options.json and the inferred pair/exposure
// branches agree without a separate data field. Title/label alone is not
// enough: the deepest-integration stacks (e.g. M31_1.jpg) carry a plain
// "Download this image" declared row that wins over inference, so the only
// way to know it's the high-integration side is that its path matches the
// item's exposure-pair long side. Same idea for the conditioned side.
function downloadKind(spec = {}, item = null) {
  const path  = String(spec.path || "");
  const t     = String(spec.title || "").toLowerCase();
  const label = String(spec.label || "");
  // Conditioned image → gold.
  if (label.includes("★") || /conditioned|enhanced/.test(t)) return "conditioned";
  if (item && item.pair && path && path === item.pair.condPath) return "conditioned";
  // A conditioned render with no raw sibling — M 52, and every
  // Seestar-enhanced frame whose stack was never kept. There is no pair to
  // match against and its declared row is the generic single-button
  // default, so the two tests above both miss and the button came out
  // neutral gray reading "Download": the one render on the target looked,
  // from the button, exactly like an untouched stack. The item itself
  // knows what it is.
  if (item && path && path === item.path
      && String(item.device || "").toLowerCase() === "conditioned") {
    return "conditioned";
  }
  // Deepest / highest-integration stack → cyan.
  if (/longer exposure|integration|deepest|highest/.test(t)) return "integration";
  if (item && item.exposurePair && path && path === item.exposurePair.longPath) return "integration";
  return "raw";
}
function applyDownloadKind(btn, kind) {
  if (!btn) return;
  btn.classList.remove("dl-raw", "dl-conditioned", "dl-integration");
  btn.classList.add("dl-" + kind);
}

// A download button must offer WHAT THE SLIDE IS SHOWING, and must say so.
//
// Two faults met here. paintSlide wires the buttons from `item`, and the
// mode branches below then replace the picture: showcase swaps in an
// integration step (`modeItem()` returns the RAW photo in that mode), and
// compare swaps in the two halves of a slider. A button left wired from the
// item hands over a different file than the one on screen. And the pair
// slides drew bare icon circles, so even when the file was right nothing on
// the button said what it was.
//
// So: every mode that changes the image re-wires through here, and the
// label is derived from the kind rather than passed in. A caller cannot
// produce a nameless button, and a single button on a slide with no variants
// just reads "Download".
const DL_LABEL = {
  raw:         "Download raw",
  conditioned: "Download conditioned",
  integration: "Download deeper",
};
const DL_MARK = { raw: "↓", conditioned: "↓★", integration: "↓⏱" };

function setDownloadButtons(specs) {
  const list = (specs || []).filter(s => s && s.path);
  [$("#slide-download-a"), $("#slide-download-b")].forEach((btn, i) => {
    if (!btn) return;
    const s = list[i];
    if (!s) { btn.hidden = true; return; }
    const kind = s.kind || "raw";
    // One button usually means there is nothing to contrast it with, so the
    // variant word would be noise — but "Download" is always there.
    //
    // Unless the lone button is not a plain stack. "Download conditioned"
    // on a solo conditioned render is the opposite of noise: it is the only
    // place the page says which render you are being handed, and without it
    // a processed frame and an untouched one offer an identical button.
    const solo = list.length === 1 && kind === "raw";
    const words = s.label
      || (solo ? "Download" : (DL_LABEL[kind] || "Download"));
    const text = `${DL_MARK[kind] || "↓"} ${words}`
      + (s.note ? ` (${s.note})` : "");
    btn.hidden = false;
    // Always the labeled pill now that every button carries words.
    btn.classList.remove("icon");
    btn.classList.add("solo");
    applyDownloadKind(btn, kind);
    // A capture is a blob: URL held in the page, not a file on the server.
    // Appending the asset cache-buster to one produces an unusable href, and
    // its last path segment is a UUID rather than a name worth saving under,
    // so both are taken from the spec instead.
    const isLocal = /^(blob:|data:)/.test(s.path);
    btn.href = isLocal ? s.path : vURL(s.path);
    btn.setAttribute("download",
      s.filename || s.path.split("/").pop() || "image.jpg");
    btn.title = text;
    btn.setAttribute("aria-label", text);
    btn.textContent = text;
  });
}

/* The captured image, in the big frame at the top.
 *
 * It goes in the PAIR frame, not the stage. The stage is rotated 90 degrees
 * because the album's photographs are portrait and the frame is landscape;
 * a capture is already landscape, so the rotated stage would stand it on
 * its side. The pair frame is the existing unrotated surface and needs no
 * new markup for this. */
function paintCaptureSlide(rec) {
  const stage = $("#slide-stage");
  const pairFrame = $("#slide-pair-frame");
  const scrub = $("#slide-sc-scrub");
  if (scrub) scrub.hidden = true;
  if (stage) stage.hidden = true;
  const blend = $("#slide-sc-blend");
  if (blend) { blend.hidden = true; blend.style.opacity = "0"; }
  if (pairFrame) {
    pairFrame.hidden = false;
    pairFrame.innerHTML =
      `<img class="capture-slide-img" src="${escapeAttr(rec.url)}" alt="Your capture">`;
  }
  const deg = `${rec.wDeg.toFixed(2)}° × ${rec.hDeg.toFixed(2)}°`;
  const nm = $("#slide-name");
  if (nm) {
    nm.innerHTML = [
      `<span class="id">CAPTURE</span>`,
      `<span>${escapeHtml(deg)}</span>`,
      `<span class="sub">${rec.frames} frame${rec.frames === 1 ? "" : "s"}</span>`,
      `<span class="sub">${rec.w} × ${rec.h}</span>`,
    ].join("");
  }
  const stats = $("#slide-stats");
  if (stats) {
    stats.innerHTML = rec.labels && rec.labels.length
      ? `<span>${escapeHtml([...new Set(rec.labels)].slice(0, 6).join(" · "))}</span>`
      : "";
  }
  // The preview is on screen; the download hands over the full-resolution
  // blob. Same rule as everywhere else — the button says what it gives you.
  setDownloadButtons([{ path: rec.url, filename: rec.name, kind: "integration",
                        label: "Download capture" }]);
  // A capture is not a catalogue object: it has no modes, no conditioned
  // sibling, no note and no showcase. paintSlide returns early for one, so
  // whatever the last subject left on screen would otherwise still be there
  // — including the mode row and its CONDITIONED tab, and the second
  // download button offering a conditioned render that does not exist.
  // "#slide-dome-btn" too: a capture has no entry in photos.json, so
  // currentItem() is null for one and the button would still be carrying
  // whatever the last real slide left on it — offering to fly to a
  // photograph that is no longer on screen.
  for (const id of ["#slide-info-btn", "#slide-note-btn", "#slide-ss-btn",
                    "#slide-sc-btn", "#slide-frame-step", "#slide-modes",
                    "#slide-download-b", "#slide-dome-btn"]) {
    const el = $(id);
    if (el) el.hidden = true;
  }
  for (const id of ["#slide-info-panel", "#slide-note-panel", "#slide-ss-panel",
                    "#slide-sc-panel", "#slide-inframe"]) {
    const el = $(id);
    if (el) el.hidden = true;
  }
}

function showCapture(rec) {
  state.viewingCapture = rec;
  paintSlide();
  const sec = $("#slideshow");
  if (sec && sec.scrollIntoView) {
    try { sec.scrollIntoView({ behavior: "smooth", block: "start" }); }
    catch (_) { sec.scrollIntoView(); }
  }
}

/* Cross-fade the big picture: out, swap, in.
 *
 * Keyed on the SOURCE actually changing, not on paintSlide running.
 * paintSlide runs for many reasons that leave the same photograph on
 * screen — a panel opening, the language flipping, a resize — and fading
 * on every one of them would blink the album at a reader who pressed (i).
 *
 * Out is quicker than in. A fade-out is dead time before anything happens,
 * so pressing › feels sluggish if it is generous; a fade-in is the picture
 * arriving, and can afford to be.
 *
 * The swap waits for decode() where it exists, so what fades in is the new
 * photograph rather than a blank frame that pops a moment later — these
 * are megabyte JPEGs and on a cold cache that gap is visible.
 *
 * Showcase mode drives the same element continuously as its slider is
 * dragged, and passes fade:false: dragging should dissolve between stacks,
 * not flash once per step.
 */
const SLIDE_FADE_OUT_MS = 190;
const SLIDE_FADE_IN_MS = 380;
let slideFadeTimer = null;

function setSlideSrc(img, src, fade, onReady) {
  if (!img) return;
  const already = img._slideSrc === src;
  const first = !img._slideShown;
  img._slideSrc = src;
  img._slideShown = true;
  if (slideFadeTimer !== null) { clearTimeout(slideFadeTimer); slideFadeTimer = null; }
  const show = () => {
    // Superseded while we were away: the newer call owns the element now.
    if (img._slideSrc !== src) return;
    img.style.transitionDuration = SLIDE_FADE_IN_MS + "ms";
    img.style.opacity = "1";
    if (onReady) onReady();
  };
  // Motion turned down: swap it and be done. A cross-fade on a full-frame
  // photograph is a large area changing luminance, which is the thing that
  // preference is asking not to have — and half a fade with the transition
  // disabled would be a blank frame instead.
  const reduce = typeof window !== "undefined" && window.matchMedia
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  // Same picture, a caller that wants it now, or the very first paint —
  // there is nothing to fade FROM.
  if (already || !fade || reduce || first) {
    if (img.src !== src) img.src = src;
    show();
    return;
  }
  img.style.transitionDuration = SLIDE_FADE_OUT_MS + "ms";
  img.style.opacity = "0";
  slideFadeTimer = setTimeout(() => {
    slideFadeTimer = null;
    if (img._slideSrc !== src) return;
    img.src = src;
    if (img.decode) img.decode().then(show, show);
    else show();
  }, SLIDE_FADE_OUT_MS);
}

function paintSlide() {
  // Any repaint is a navigation of some kind, and a blow-up belongs to the
  // photograph that was on screen when it was opened.
  closeBlowup();
  if (state.viewingCapture) {
    // A capture is not a target and has no other frames; renderStrip sees
    // that and empties the row rather than leaving the last target's.
    renderStrip();
    // A capture belongs to nobody's family. Cleared explicitly, or the row
    // keeps the last target's links and offers to open an object that has
    // nothing to do with the picture on screen.
    renderFamilyRow(null);
    paintCaptureSlide(state.viewingCapture);
    return;
  }
  const subj = currentSubject();
  if (!subj) return;
  if (!subj.available.includes(state.mode)) state.mode = subj.available[0];
  const item = currentItem();
  if (!item) return;
  // Keep the flat index in step: annotations, the resize handler and
  // openPhotoByPath all still address photographs, not subjects.
  const flat = state.items.indexOf(item);
  if (flat >= 0) state.index = flat;
  renderModeRow();
  renderFrameStep();
  renderStrip();
  renderViewNumber();
  renderStarButton();
  renderSlideshowButton();
  const img = $("#slide-img");
  const stage = $("#slide-stage");
  const pairFrame = $("#slide-pair-frame");
  // Counts the list actually being walked, so a filtered album reads
  // "3 / 17" rather than claiming a position among all 130.
  $("#slide-pos").textContent = String(state.subject + 1);
  $("#slide-total").textContent = String(navList().length);
  /* The headline names the TARGET, and on a family photo the target is the
   * family — not the object whose name happened to be in the filename.
   * Read off the item, this printed "M 8 · Lagoon Nebula" over a picture
   * the grid, the section and the search had all just called Lagoon &
   * Trifid. The id chip gives way to the ribbon there too: an id chip
   * reading "FAM-M8-M20" is machinery, not a catalogue designation. */
  const head = subj.isFamily ? subj : item;
  $("#slide-name").innerHTML = [
    subj.isFamily
      ? `<span class="slide-family-ribbon">${escapeHtml(
            I18N[LANG].familyRibbon || I18N.en.familyRibbon)}</span>`
      : `<span class="id">${escapeHtml(tId(item.objId))}</span>`,
    `<span>${escapeHtml(tName(head.objName || head.objId))}</span>`,
    head.objType ? `<span class="sub">${escapeHtml(tType(head.objType))}</span>` : "",
    head.objConstellation ? `<span class="sub">${escapeHtml(tName(head.objConstellation))}</span>` : "",
  ].filter(Boolean).join("");
  const stats = $("#slide-stats");
  if (stats) stats.innerHTML = slideStatsHtml(item.exif);
  renderFamilyRow(subj);

  // (i) info button — shown for every conditioned photo (paired or solo).
  // (n) note button — shown when data/notes.json has an entry for this
  // slide's objId. Either, both, or neither may be visible; the wrapper
  // itself always renders because it also hosts the "In frame:" chip row.
  //
  // Copy varies by `conditionedBy`: files from my Python pipeline show
  // the "in-house pipeline" text; files enhanced by the Seestar S30
  // app's built-in AI show the Seestar text. Pair items are always
  // custom (the raw+conditioned compare only exists for pipeline runs).
  const infoPanel = $("#slide-info-panel");
  const infoBtn = $("#slide-info-btn");
  if (infoPanel && infoBtn) {
    const dict = I18N[LANG];
    const isCond = (item.device || "").toLowerCase() === "conditioned" || !!item.pair;
    infoBtn.hidden = !isCond;
    if (isCond) {
      const isSeestar = !item.pair && (item.conditionedBy === "seestar");
      const title = isSeestar ? dict.seestarInfoTitle : dict.conditionedInfoTitle;
      infoBtn.setAttribute("aria-label", title);
      infoBtn.title = title;
      // The album's own chain is a SEQUENCE, so it reads as one. It used to
      // be a single paragraph with arrows buried in it, and it had gone
      // stale besides — it still described a BM3D pass and a synthetic
      // star-field step, neither of which has run since the 2026-07-30
      // rebuild. Bullets make each stage checkable against the code.
      const bullets = isSeestar ? null : dict.conditionedInfoBullets;
      const head = `<div class="slide-info-title">${escapeHtml(title)}</div>`;
      infoPanel.innerHTML = head + (Array.isArray(bullets) && bullets.length
        ? `<ul class="slide-info-list">${
             bullets.map(b => `<li>${escapeHtml(b)}</li>`).join("")}</ul>`
        : `<div class="slide-info-body">${escapeHtml(dict.seestarInfoBody)}</div>`);
    }
    infoPanel.hidden = true;
    infoBtn.setAttribute("aria-expanded", "false");
  }
  // "Goto Sky Dome" — shown for any slide the album has a plate solve for.
  const domeJump = $("#slide-dome-btn");
  if (domeJump) domeJump.hidden = !hasSkyPlace(item);
  // Download links. Every button says the word "Download" and which
  // variant it fetches — the pair slides used to show bare icon circles
  // ("↓" / "↓★") and there was no way to tell what you were about to
  // get. Building a spec list and handing it to ONE writer is what keeps
  // that true: the labels are derived from the kind in setDownloadButtons,
  // so a branch cannot ship a nameless button.
  //
  // Declared option rows win. data/photo_options.json lists, per photo,
  // exactly which downloads belong under it; we take their paths and let
  // the writer name them.
  const declared = ((PHOTO_OPTIONS.byPath || {})[item.path] || {}).downloads;
  let specs;
  if (Array.isArray(declared) && declared.length > 0) {
    specs = declared
      .filter(s => s && s.path)
      .map(s => ({ path: s.path, kind: downloadKind(s, item) }));
  } else if (item.pair) {
    specs = [{ path: item.pair.rawPath,  kind: "raw" },
             { path: item.pair.condPath, kind: "conditioned" }];
  } else if (item.exposurePair) {
    specs = [
      { path: item.exposurePair.shortPath, kind: "raw",
        note: formatExposure(item.exposurePair.shortExpS) },
      { path: item.exposurePair.longPath,  kind: "integration",
        note: formatExposure(item.exposurePair.longExpS) },
    ];
  } else {
    specs = [{ path: item.path, kind: "raw" }];
  }
  setDownloadButtons(specs);


  const notePanel = $("#slide-note-panel");
  const noteBtn = $("#slide-note-btn");
  if (notePanel && noteBtn) {
    const dict = I18N[LANG];
    // Per-photo note first; fall back to the per-object note so objects
    // that have not been written up individually still say something.
    const perPhoto = (PHOTO_OPTIONS.byPath || {})[item.path];
    const noteRec = (perPhoto && perPhoto.note)
      || (NOTES.byObjId || {})[item.objId]
      || null;
    const noteText = noteRec ? (noteRec[LANG] || noteRec.en || "") : "";
    noteBtn.hidden = !noteText;
    if (noteText) {
      noteBtn.setAttribute("aria-label", dict.noteTitle);
      noteBtn.title = dict.noteTitle;
      notePanel.innerHTML = `<div class="slide-info-title" style="color:#7dd3fc">${escapeHtml(dict.noteTitle)}</div>
        <div class="slide-info-body">${escapeHtml(noteText)}</div>`;
    }
    notePanel.hidden = true;
    noteBtn.setAttribute("aria-expanded", "false");
  }

  // (s) supporting screenshots — visible if the objId has one or more
  // entries in data/screenshots.json. Renders exactly like (i) and (n):
  // click toggles an inline panel below the icons showing the close-up
  // image. Multi-shot objects get small ← → arrows + a counter inside
  // the panel; single-shot skips the nav row.
  const ssBtn = $("#slide-ss-btn");
  const ssPanel = $("#slide-ss-panel");
  if (ssBtn && ssPanel) {
    const shots = (SCREENSHOTS.byObjId || {})[item.objId] || [];
    ssBtn.hidden = shots.length === 0;
    if (shots.length) {
      ssBtn.title = shots.length === 1
        ? "See supporting close-up"
        : `See supporting close-ups (${shots.length})`;
      _ssItem = item;
      _ssIndex = 0;
      renderScreenshotPanel();
    }
    ssPanel.hidden = true;
    ssBtn.setAttribute("aria-expanded", "false");
  }

  // The (t) icon used to open a panel of the integration milestones. The
  // showcase is one of the four modes now, with the whole frame to itself
  // and a slider over it, so the icon would be a second, smaller way into
  // the same pictures. Kept in the markup, never shown.
  const scBtn = $("#slide-sc-btn");
  const scPanel = $("#slide-sc-panel");
  if (scBtn && scPanel) {
    scBtn.hidden = true;
    scPanel.hidden = true;
    scBtn.setAttribute("aria-expanded", "false");
  }

  const scrub = $("#slide-sc-scrub");
  if (state.mode === "showcase" && subj.showcase) {
    // Integration showcase: the same target at 1, 10, 30, 60, 120 minutes,
    // driven by a slider over the image. Uses the ordinary rotated stage,
    // so it inherits the stage's geometry and its annotation layer.
    if (pairFrame) { pairFrame.hidden = true; pairFrame.innerHTML = ""; }
    if (stage) stage.hidden = false;
    const steps = subj.showcase.steps || [];
    const last = steps.length - 1;
    state.scPos = Math.max(0, Math.min(state.scPos, last));
    state.scIndex = Math.max(0, Math.min(Math.round(state.scPos), last));
    // Dissolve between the two real stacks the slider sits between. The
    // milestones are far apart (1, 10, 30, 60, 120 min) and cutting between
    // them read as the picture being swapped rather than deepening.
    //
    // The blend is a TRANSITION, not a synthetic milestone: averaging a
    // 10-min and a 30-min stack cancels noise better than a true 20-min
    // integration would, so it must never be labelled as one. The readout
    // names the two stacks it is between, and the download button always
    // offers a real file — the nearer milestone, never the blend.
    const i0 = Math.max(0, Math.min(Math.floor(state.scPos), last));
    const i1 = Math.min(i0 + 1, last);
    const frac = i1 > i0 ? state.scPos - i0 : 0;
    const cur = steps[state.scIndex];
    if (scrub) { scrub.hidden = false; renderShowcaseScrub(subj, steps); }
    // No fade: this one is dragged, and a fade per step would strobe.
    setSlideSrc(img, vURL(steps[i0].path), false);
    img.alt = `${item.objName || item.objId} at ${fmtMinutes(scStepMin(steps, state.scIndex))}`;
    const blend = $("#slide-sc-blend");
    if (blend) {
      if (frac > 0.001) {
        const want = vURL(steps[i1].path);
        if (blend.getAttribute("src") !== want) blend.src = want;
        blend.hidden = false;
        blend.style.opacity = String(frac);
      } else {
        blend.hidden = true;
        blend.style.opacity = "0";
      }
    }
    setDownloadButtons([{ path: cur.path, kind: "integration",
                          note: fmtMinutes(scStepMin(steps, state.scIndex)) }]);
    sizeStage();
    img.onload = () => { sizeStage(); drawAnnotations(item); };
    if (img.complete && img.naturalWidth) drawAnnotations(item);
    renderInFrameChips(item);
    return;
  }
  if (scrub) scrub.hidden = true;
  // Leaving showcase mode: the cross-fade layer would otherwise stay
  // painted over the next slide.
  const blendOff = $("#slide-sc-blend");
  if (blendOff) { blendOff.hidden = true; blendOff.style.opacity = "0"; }

  if (state.mode === "compare" && (item.pair || item.exposurePair)) {
    // Compare-slider modes — either raw/conditioned (item.pair) or
    // short/long exposure (item.exposurePair). Both swap the rotated
    // stage for an unrotated frame so pointer coords map directly to
    // divider position.
    if (stage) stage.hidden = true;
    if (pairFrame) {
      pairFrame.hidden = false;
      pairFrame.innerHTML = "";
      let leftPath, rightPath, labels;
      if (item.pair) {
        leftPath  = item.pair.rawPath;
        rightPath = item.pair.condPath;
        labels    = I18N[LANG].pairLabels || I18N.en.pairLabels
                    || { before: "Raw", after: "Conditioned" };
      } else {
        // Exposure pair: build minute-based labels so the user knows
        // which side is the longer integration. `fmtExposure` prints
        // e.g. "10 min" / "48 min" for readability.
        leftPath  = item.exposurePair.shortPath;
        rightPath = item.exposurePair.longPath;
        labels    = {
          before: `⏱ ${formatExposure(item.exposurePair.shortExpS) || item.exposurePair.shortExpS + "s"}`,
          after:  `⏱ ${formatExposure(item.exposurePair.longExpS)  || item.exposurePair.longExpS  + "s"}`,
        };
      }
      pairFrame.appendChild(makeCompareSlider(leftPath, rightPath, labels));
      // Same rule as showcase: the slider decides which two files are on
      // screen, so the buttons follow it rather than the declared row. An
      // exposure-pair slide whose declared row is the single "Download this
      // image" would otherwise offer one file while showing two.
      setDownloadButtons([
        { path: leftPath,  kind: "raw" },
        { path: rightPath, kind: item.pair ? "conditioned" : "integration" },
      ]);
    }
    // Pair viewer has no annotations layer, but the chip list is still
    // informative — show the bodies in-frame; the click no-op is handled
    // in renderInFrameChips via item.pair check.
    renderInFrameChips(item);
    return;
  }
  // Normal (non-pair) slide: restore the rotated stage + flat image
  if (pairFrame) { pairFrame.hidden = true; pairFrame.innerHTML = ""; }
  if (stage) stage.hidden = false;
  img.alt = item.objName || item.objId;
  setSlideSrc(img, vURL(item.path), true);
  sizeStage();
  img.onload = () => {
    sizeStage();
    drawAnnotations(item);
  };
  if (img.complete && img.naturalWidth) {
    drawAnnotations(item);
  }
}

/* Is the photograph on the stage taller than it is wide?
 *
 * The album is almost entirely Seestar frames, which come off the mount in
 * portrait, and the slide frame is 16/9 — so the stage turns its content a
 * quarter turn and a portrait photograph fills a landscape frame. That was
 * unconditional, which is right up until a source is ALREADY landscape:
 * then the same quarter turn lays it on its side. Seven frames shipped that
 * way (an iPhone Moon, and the six pair members publish used to pre-rotate).
 *
 * So the rotation is now a question about the image rather than a constant.
 * Everything ends up landscape either way, which is what the annotation
 * geometry and the circles are drawn against. */
function stageIsPortraitSource() {
  const img = $("#slide-img");
  if (!img || !img.naturalWidth || !img.naturalHeight) return true;  // assume the album's norm
  return img.naturalHeight >= img.naturalWidth;
}

function sizeStage() {
  const stage = $("#slide-stage");
  const area  = $("#slide-frame");
  if (!stage || !area) return;
  const w = area.clientWidth;
  const h = area.clientHeight;
  // If the frame hasn't been laid out yet (first synchronous paint before
  // the CSS aspect-ratio resolves), width/height come back as 0. Skipping
  // the transform would leave the stage stuck at the CSS default (which
  // rotates the content off-screen to the left). Retry next frame.
  if (w === 0 || h === 0) {
    requestAnimationFrame(sizeStage);
    return;
  }
  const turn = stageIsPortraitSource();
  // The class is what the counter-rotation of the label glyphs keys off,
  // so it has to be set before anything is drawn on the annotation layer.
  stage.classList.toggle("is-upright", !turn);
  if (!turn) {
    // Already landscape: the stage IS the frame and nothing turns.
    stage.style.width  = `${w}px`;
    stage.style.height = `${h}px`;
    stage.style.transform = "translate(0, 0) rotate(0deg) scale(1)";
    return;
  }
  stage.style.width  = `${h}px`;
  stage.style.height = `${w}px`;
  // Rotate 90° CW around the stage's top-left (transform-origin 0 0)
  // sends its rendered content into negative-x space. Translating by the
  // frame's width brings it back into view so it fills the landscape
  // slide frame exactly. Without this, the stage draws off-screen to
  // the left and the slideshow area looks empty.
  stage.style.transform = `translate(${w}px, 0) rotate(90deg) scale(1)`;
}
window.addEventListener("resize", sizeStage);

/* Arrows move between TARGETS now, not between photographs. Stepping
 * through eight versions of M 31 to reach M 32 was the thing the one-card
 * grid was meant to stop; the arrows had the same problem. */
/* ── Slideshow ─────────────────────────────────────────────────────
 *
 * Auto-advance through whatever the grid is currently showing. It walks
 * navList(), so a slideshow started while filtered to galaxies is a galaxy
 * slideshow — the filter row doubles as the playlist and there is no second
 * concept to build or explain.
 *
 * The timer is rearmed from showSubject(), not from paintSlide(). paintSlide
 * has four early returns, including the compare branch, so a hook at its end
 * dies silently the moment the show reaches a before/after target — the
 * failure would look like "the slideshow randomly stops". showSubject is the
 * single funnel every target change passes through.
 */
const SLIDESHOW_MS = 6000;
// Left running with nobody at the keyboard, the show stops after this long.
// Every advance decodes a full-size photograph and warms its neighbours, so
// a show playing to an empty room all night churns the whole album through
// memory for no one.
const SLIDESHOW_IDLE_MS = 30 * 60 * 1000;
let slideshowTimer = null;
// Hidden tab: the show is still ON (the button says so), but no timer runs.
// onVisibility re-arms it.
let slideshowPaused = false;

function slideshowRunning() { return slideshowTimer !== null || slideshowPaused; }

function slideshowArm() {
  if (slideshowTimer !== null) clearTimeout(slideshowTimer);
  slideshowPaused = false;
  slideshowTimer = setTimeout(() => {
    slideshowTimer = null;
    // A hidden tab should not burn through the album behind the reader's
    // back. It used to re-arm and check again every 6 s for as long as the
    // tab stayed hidden; now it parks, and coming back to the tab resumes.
    if (typeof document !== "undefined" && document.hidden) {
      slideshowPaused = true;
      return;
    }
    if (performance.now() - lastActivityAt > SLIDESHOW_IDLE_MS) {
      slideshowStop();
      return;
    }
    slideshowAdvance();
  }, SLIDESHOW_MS);
}

/* Where the slideshow goes next: a shuffled walk rather than a march down
 * the list.
 *
 * A bag, not a die. Drawing independently at random repeats targets and
 * leaves others unseen for a long time — over 130 targets you would watch
 * the same handful come round while a third of the album never appeared.
 * This deals the whole list out in a random order and only reshuffles once
 * every target has had its turn, so the show is unpredictable AND complete.
 *
 * The bag is rebuilt whenever the list it was dealt from changes size,
 * which is what a filter or a search does.
 */
let ssBag = [];
let ssBagFor = -1;

function slideshowNextIndex() {
  const n = navList().length;
  if (!n) return -1;
  if (ssBagFor !== n || !ssBag.length) {
    ssBag = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = ssBag[i]; ssBag[i] = ssBag[j]; ssBag[j] = t;
    }
    ssBagFor = n;
    // Don't open a fresh cycle on the target already on screen — one
    // tick where nothing appears to happen reads as the show being stuck.
    if (n > 1 && ssBag[n - 1] === state.subject) {
      ssBag[n - 1] = ssBag[0];
      ssBag[0] = state.subject;
    }
  }
  return ssBag.pop();
}

function slideshowAdvance() {
  const list = navList();
  if (!list.length) { slideshowStop(); return; }
  // Advance WITHOUT going through goSlide, because every manual navigator
  // stops the show and goSlide is one of them.
  const next = slideshowNextIndex();
  showSubject(next < 0 ? state.subject + 1 : next);
  slideshowArm();
  renderSlideshowButton();
}

function slideshowStart() {
  if (slideshowRunning()) return;
  slideshowArm();
  renderSlideshowButton();
}

function slideshowStop() {
  if (slideshowTimer !== null) clearTimeout(slideshowTimer);
  slideshowTimer = null;
  slideshowPaused = false;
  renderSlideshowButton();
}

function slideshowToggle() {
  if (slideshowRunning()) slideshowStop(); else slideshowStart();
}

function renderSlideshowButton() {
  const btn = $("#slide-play");
  if (!btn) return;
  const on = slideshowRunning();
  btn.classList.toggle("is-on", on);
  btn.textContent = on ? "⏸" : "▶";
  const label = on ? (I18N[LANG].slideshowStop  || "Stop slideshow")
                   : (I18N[LANG].slideshowStart || "Play slideshow");
  btn.title = label + " (space)";
  btn.setAttribute("aria-label", label);
  btn.setAttribute("aria-pressed", on ? "true" : "false");
}

function goSlide(delta) {
  slideshowStop();
  if (!navList().length) return;
  showSubject(state.subject + delta);
}

// ── Callouts (from ASTAP cache) + PCA ellipses for galaxies ─────────
const _pcaImagePixelCache = new WeakMap();
function grabImagePixels(img) {
  if (!img || !img.naturalWidth) return null;
  const src = img.currentSrc || img.src;
  const cached = _pcaImagePixelCache.get(img);
  if (cached && cached.src === src && cached.W === img.naturalWidth) {
    return cached.data ? cached : null;
  }
  const W = img.naturalWidth, H = img.naturalHeight;
  try {
    const c = document.createElement("canvas");
    c.width = W; c.height = H;
    c.getContext("2d").drawImage(img, 0, 0);
    const data = c.getContext("2d").getImageData(0, 0, W, H).data;
    const entry = { src, W, H, data };
    _pcaImagePixelCache.set(img, entry);
    return entry;
  } catch (e) {
    _pcaImagePixelCache.set(img, { src, W: -1, H: -1, data: null });
    return null;
  }
}

// Fit a brightness-weighted ellipse to a galaxy at (cxPx, cyPx) with
// expected major axis catalogMajAxPx. Uses 5×5 median filter to kill
// stars, PCA covariance for orientation, 95th-percentile isophotal for
// extent. Returns {cx, cy, rx, ry, angleDeg} or null.
function computePCAEllipse(img, cxPx, cyPx, catalogMajAxPx) {
  const pix = grabImagePixels(img);
  if (!pix) return null;
  const { data, W, H } = pix;
  const catalogRadPx = (catalogMajAxPx || 40) * 0.5;
  const winHalf = Math.max(20, Math.min(300, Math.round(catalogRadPx * 1.2)));
  const x0 = Math.max(0, Math.round(cxPx - winHalf));
  const y0 = Math.max(0, Math.round(cyPx - winHalf));
  const x1 = Math.min(W, Math.round(cxPx + winHalf));
  const y1 = Math.min(H, Math.round(cyPx + winHalf));
  if (x1 - x0 < 20 || y1 - y0 < 20) return null;
  const ww = x1 - x0, wh = y1 - y0;
  const lumRaw = new Float32Array(ww * wh);
  let li = 0;
  for (let y = y0; y < y1; y++) {
    let rowStart = (y * W + x0) * 4;
    for (let x = x0; x < x1; x++, rowStart += 4) {
      lumRaw[li++] = 0.2126 * data[rowStart] + 0.7152 * data[rowStart + 1] + 0.0722 * data[rowStart + 2];
    }
  }
  // 5×5 median filter — de-stars.
  const lum = new Float32Array(ww * wh);
  const buf = new Float32Array(25);
  for (let y = 0; y < wh; y++) {
    for (let x = 0; x < ww; x++) {
      if (x < 2 || y < 2 || x >= ww - 2 || y >= wh - 2) {
        lum[y * ww + x] = lumRaw[y * ww + x];
        continue;
      }
      let k = 0;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++)
          buf[k++] = lumRaw[(y + dy) * ww + (x + dx)];
      buf.sort();
      lum[y * ww + x] = buf[12];
    }
  }
  const sorted = Float32Array.from(lum);
  sorted.sort();
  const bg = sorted[Math.floor(sorted.length * 0.40)];
  let noiseSum = 0, noiseCount = 0;
  for (let i = 0; i < sorted.length * 0.40; i++) {
    const d = sorted[i] - bg;
    noiseSum += d * d;
    noiseCount++;
  }
  const noiseSigma = Math.sqrt(noiseSum / Math.max(1, noiseCount));
  const threshold = bg + Math.max(3, noiseSigma * 1.5);
  let sumW = 0, sumX = 0, sumY = 0, usedPx = 0;
  li = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++, li++) {
      const l = lum[li];
      if (l <= threshold) continue;
      const w = l - bg;
      sumW += w; sumX += x * w; sumY += y * w; usedPx++;
    }
  }
  if (usedPx < 20 || sumW <= 0) return null;
  const mx = sumX / sumW, my = sumY / sumW;
  let sumXX = 0, sumYY = 0, sumXY = 0;
  li = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++, li++) {
      const l = lum[li];
      if (l <= threshold) continue;
      const w = l - bg;
      const dx = x - mx, dy = y - my;
      sumXX += dx * dx * w; sumYY += dy * dy * w; sumXY += dx * dy * w;
    }
  }
  const vXX = sumXX / sumW, vYY = sumYY / sumW, vXY = sumXY / sumW;
  const angleRad = 0.5 * Math.atan2(2 * vXY, vXX - vYY);
  const angleDeg = angleRad * 180 / Math.PI;
  if (Math.abs(mx - cxPx) > winHalf * 0.7 || Math.abs(my - cyPx) > winHalf * 0.7) return null;
  const cosA = Math.cos(angleRad), sinA = Math.sin(angleRad);
  const xProjs = [], yProjs = [];
  li = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++, li++) {
      if (lum[li] <= threshold) continue;
      const dx = x - mx, dy = y - my;
      xProjs.push(Math.abs( dx * cosA + dy * sinA));
      yProjs.push(Math.abs(-dx * sinA + dy * cosA));
    }
  }
  if (xProjs.length < 20) return null;
  xProjs.sort((a, b) => a - b);
  yProjs.sort((a, b) => a - b);
  const p95 = (arr) => arr[Math.floor(arr.length * 0.95)];
  const MARGIN = 1.15;
  const rx = Math.max(4, p95(xProjs) * MARGIN);
  const ry = Math.max(4, p95(yProjs) * MARGIN);
  const aspect = rx / ry;
  if (!Number.isFinite(aspect) || aspect > 5) return null;
  return { cx: mx, cy: my, rx, ry, angleDeg };
}

// Small helpers used by drawAnnotations.
function isTooSmallToLabel(obj, scale) {
  const arcmin = (obj && typeof obj.majAxisArcmin === "number") ? obj.majAxisArcmin : null;
  if (!arcmin || !scale) return false;
  return (arcmin * 60 / scale) < 5;
}
function sizeBasedRPctW(obj, scale, W, isCenter) {
  const arcmin = (obj && typeof obj.majAxisArcmin === "number") ? obj.majAxisArcmin : null;
  if (!arcmin || !scale || !W) return null;
  const t = (obj.type || "").toLowerCase();
  let mult = 1.15;
  if (t.includes("planetary")) mult = 1.15;
  else if (t.includes("nebula") || t.includes("hii")) mult = 0.55;
  else if (t.includes("cluster") || t.includes("association")) mult = 1.0;
  const radiusPx = (arcmin * 60 * 0.5 * mult) / scale;
  const minPx = isCenter ? 28 : 22;
  const maxPx = W * 0.35;
  const clamped = Math.max(minPx, Math.min(radiusPx, maxPx));
  return (clamped / W) * 100;
}
function hasDetectableSignal(img, cx, cy, expectedRadius) {
  const pix = grabImagePixels(img);
  if (!pix) return true;
  const { data, W, H } = pix;
  const winHalf = Math.max(15, Math.min(60, Math.round((expectedRadius || 20) * 1.4)));
  const x0 = Math.max(0, Math.round(cx - winHalf));
  const y0 = Math.max(0, Math.round(cy - winHalf));
  const x1 = Math.min(W, Math.round(cx + winHalf));
  const y1 = Math.min(H, Math.round(cy + winHalf));
  if (x1 - x0 < 10 || y1 - y0 < 10) return false;
  const L = (i) => 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
  const perimLen = 2 * (x1 - x0) + 2 * (y1 - y0) - 4;
  const perim = new Float32Array(perimLen);
  let pi = 0;
  for (let x = x0; x < x1; x++) {
    perim[pi++] = L((y0 * W + x) * 4);
    perim[pi++] = L(((y1 - 1) * W + x) * 4);
  }
  for (let y = y0 + 1; y < y1 - 1; y++) {
    perim[pi++] = L((y * W + x0) * 4);
    perim[pi++] = L((y * W + (x1 - 1)) * 4);
  }
  const sorted = Float32Array.from(perim);
  sorted.sort();
  const bg = sorted[Math.floor(sorted.length / 2)];
  const mad = new Float32Array(sorted.length);
  for (let i = 0; i < sorted.length; i++) mad[i] = Math.abs(sorted[i] - bg);
  mad.sort();
  const sigma = 1.4826 * mad[Math.floor(mad.length / 2)];
  const inner = Math.max(4, Math.round((expectedRadius || 10) * 0.7));
  const ix0 = Math.max(x0, Math.round(cx - inner));
  const iy0 = Math.max(y0, Math.round(cy - inner));
  const ix1 = Math.min(x1, Math.round(cx + inner));
  const iy1 = Math.min(y1, Math.round(cy + inner));
  const threshold = bg + Math.max(2, sigma * 2);
  let bright = 0, total = 0;
  for (let y = iy0; y < iy1; y++) {
    for (let x = ix0; x < ix1; x++) {
      if (L((y * W + x) * 4) > threshold) bright++;
      total++;
    }
  }
  return total > 0 && (bright / total) >= 0.03;
}

// Project (ra, dec) through a WCS to pixel coords.
//
// ASTAP emits CRPIX / CD in FITS convention: pixel (1,1) is BOTTOM-LEFT
// and Y increases UPWARD. The browser paints with origin TOP-LEFT and Y
// increasing DOWNWARD, so we flip Y at the end via `image_height - y`.
// Without the flip every callout lands mirrored across the horizontal
// midline (M32 shows up where M110 belongs and vice versa) — inside
// the 90°-CW-rotated stage that manifests to the viewer as a left/right
// mirror, which is exactly the bug reported.
function wcsProject(raDeg, decDeg, wcs) {
  if (!wcs || !wcs.crpix || !wcs.crval || !wcs.cd) return null;
  const [crpix1, crpix2] = wcs.crpix;
  const [crval1, crval2] = wcs.crval;
  const cd = wcs.cd;
  const DEG = Math.PI / 180;
  const ra = raDeg * DEG, dec = decDeg * DEG;
  const ra0 = crval1 * DEG, dec0 = crval2 * DEG;
  const cosC = Math.sin(dec0) * Math.sin(dec) + Math.cos(dec0) * Math.cos(dec) * Math.cos(ra - ra0);
  if (cosC <= 0) return null;
  const xi  = Math.cos(dec) * Math.sin(ra - ra0) / cosC;
  const eta = (Math.cos(dec0) * Math.sin(dec) - Math.sin(dec0) * Math.cos(dec) * Math.cos(ra - ra0)) / cosC;
  const xiDeg  = xi  / DEG;
  const etaDeg = eta / DEG;
  const det = cd[0][0] * cd[1][1] - cd[0][1] * cd[1][0];
  if (Math.abs(det) < 1e-12) return null;
  const dx = ( cd[1][1] * xiDeg - cd[0][1] * etaDeg) / det;
  const dy = (-cd[1][0] * xiDeg + cd[0][0] * etaDeg) / det;
  const fits_x = crpix1 + dx;
  const fits_y = crpix2 + dy;
  const imgH = (wcs.image_size && wcs.image_size[1]) || 0;
  return [fits_x, imgH > 0 ? imgH - fits_y : fits_y];
}

// Compute the list of in-frame catalog bodies for one photo. Returns
// `[{ obj, xPct, yPct, rPctW, isCenter, ellipse? }, …]` in stable order
// (center first, then top-to-bottom / right-to-left). Cached per path so
// the chip UI + search index share the same result.
//
// This is deliberately WITHOUT pixel-data checks (hasDetectableSignal,
// PCA ellipse fitting) because those need an <img> in the DOM. The chip
// list needs to be available synchronously at grid-render time (before
// any slide is opened) for the search predicate. computeMatchesWithSignal
// below re-runs with pixel checks only when actually drawing on the
// slide, and stores the refined result back into IN_FRAME_CACHE.
function computeInFrame(item) {
  const cached = IN_FRAME_CACHE.get(item.path);
  if (cached) return cached;
  // Hand-placed callouts come first, and they are the ONLY way a
  // solar-system body is ever named: the loop below skips
  // `computeAtRuntime` objects because they have no fixed RA/Dec, so
  // without these a photograph OF Pluto could not say which dot was
  // Pluto. data/photo_callouts.json was already being loaded at startup
  // and then never read by anything — the Moon/Venus entries in it had
  // never once reached the screen.
  const manual = [];
  const rec = (PHOTO_CALLOUTS.byPath || {})[item.path];
  for (const c of (rec && rec.callouts) || []) {
    const obj = CATALOG.objects.find(o => o.id === c.id);
    if (!obj || typeof c.xPct !== "number" || typeof c.yPct !== "number") continue;
    const m = { obj, xPct: c.xPct, yPct: c.yPct, isCenter: !!c.isCenter, manual: true };
    if (typeof c.rPctW === "number") m.rPctW = c.rPctW;
    manual.push(m);
  }
  const wcs = ASTAP_CACHE[item.path]?.result;
  if (!wcs || !wcs.solved) {
    // A callout needs no plate solve — it IS the position. Pluto's frame
    // has no solve at all, which is exactly when this matters.
    IN_FRAME_CACHE.set(item.path, manual);
    return manual;
  }
  const wcsW = Array.isArray(wcs.image_size) ? wcs.image_size[0] : 0;
  const wcsH = Array.isArray(wcs.image_size) ? wcs.image_size[1] : 0;
  if (!wcsW || !wcsH) { IN_FRAME_CACHE.set(item.path, []); return []; }
  const centerObj = CATALOG.objects.find(o => o.id === item.objId);
  const scale = wcs.scale_arcsec_per_pixel;
  const matches = [...manual];
  const manualIds = new Set(manual.map(m => m.obj.id));
  for (const obj of CATALOG.objects) {
    if (obj.computeAtRuntime) continue;
    if (manualIds.has(obj.id)) continue;      // a hand-placed one wins
    if (typeof obj.ra !== "number" || typeof obj.dec !== "number") continue;
    const raDeg = obj.ra * 15;  // catalog stores RA in hours
    const proj = wcsProject(raDeg, obj.dec, wcs);
    if (!proj) continue;
    const [px, py] = proj;
    // Small inside-frame margin so bodies right on the edge still count.
    if (px < 0 || py < 0 || px > wcsW || py > wcsH) continue;
    const isCenter = centerObj && obj.id === centerObj.id;
    const magCap = obj.catalog === "Stars" ? 6.5 : 12.0;
    if (!isCenter && typeof obj.magnitude === "number" && obj.magnitude > magCap) continue;
    if (!isCenter && obj.catalog !== "Stars" && isTooSmallToLabel(obj, scale)) continue;
    const rp = sizeBasedRPctW(obj, scale, wcsW, isCenter);
    const m = { obj, xPct: (px / wcsW) * 100, yPct: (py / wcsH) * 100, isCenter };
    if (rp != null) m.rPctW = rp;
    matches.push(m);
  }
  // Stable order: center first, then reading order.
  const ordered = [];
  const center = matches.find(m => m.isCenter);
  if (center) ordered.push(center);
  matches.filter(m => !m.isCenter)
    .sort((a, b) => a.yPct - b.yPct || a.xPct - b.xPct)
    .forEach(m => ordered.push(m));
  IN_FRAME_CACHE.set(item.path, ordered);
  return ordered;
}

// Populate the "In frame: <chip> <chip> …" row under the slide image.
// Each chip is a button — click toggles a circle overlay on
// #slide-annotations at the body's projected position. Only one chip is
// active at a time; clicking the active chip clears the highlight.
function renderInFrameChips(item) {
  const row   = $("#slide-inframe");
  const chips = $("#slide-inframe-chips");
  const label = $("#slide-inframe-label");
  if (!row || !chips) return;
  chips.innerHTML = "";
  const matches = computeInFrame(item);
  if (!matches.length) { row.hidden = true; return; }
  row.hidden = false;
  if (label) label.textContent = I18N[LANG].inFrameLabel || "In frame:";
  // "Add Circles". The listener is attached ONCE and reads the photograph
  // off the button, because this row is rebuilt on every slide: rebinding
  // per slide would either stack listeners or need the node replaced, and
  // both are more machinery than remembering which picture is open.
  const allBtn = $("#slide-inframe-all");
  if (allBtn) {
    allBtn.__item = item;
    allBtn.textContent = I18N[LANG].addCircles || "Add Circles";
    allBtn.setAttribute("aria-pressed", "false");
    if (!allBtn.__wired) {
      allBtn.__wired = true;
      allBtn.addEventListener("click", () => {
        const on = allBtn.getAttribute("aria-pressed") === "true";
        chips.querySelectorAll(".slide-inframe-chip")
          .forEach(c => c.setAttribute("aria-pressed", "false"));
        if (on) {
          allBtn.setAttribute("aria-pressed", "false");
          if (state.mode === "compare") clearCompareHighlight(); else clearHighlight();
          return;
        }
        allBtn.setAttribute("aria-pressed", "true");
        if (allBtn.__item) highlightAll(allBtn.__item);
      });
    }
  }
  for (const m of matches) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "slide-inframe-chip";
    btn.setAttribute("aria-pressed", "false");
    btn.dataset.id = m.obj.id;
    btn.textContent = tId(m.obj.id);
    btn.title = m.obj.name && m.obj.name !== m.obj.id
      ? `${m.obj.id} — ${tName(m.obj.name)}` : m.obj.id;
    // Compare mode draws into its own overlay: the rotated stage that
    // normally carries annotations is hidden there, so a highlight put on
    // it would be invisible.
    if (state.mode === "compare") {
      btn.addEventListener("click", () => {
        const pressed = btn.getAttribute("aria-pressed") === "true";
        chips.querySelectorAll(".slide-inframe-chip")
          .forEach(c => c.setAttribute("aria-pressed", "false"));
        $("#slide-inframe-all")?.setAttribute("aria-pressed", "false");
        if (pressed) { clearCompareHighlight(); return; }
        btn.setAttribute("aria-pressed", "true");
        highlightInCompare(item, m);
      });
      chips.appendChild(btn);
      continue;
    }
    btn.addEventListener("click", () => {
      const pressed = btn.getAttribute("aria-pressed") === "true";
      // Clear all chips' pressed state first
      chips.querySelectorAll(".slide-inframe-chip")
        .forEach(c => c.setAttribute("aria-pressed", "false"));
      $("#slide-inframe-all")?.setAttribute("aria-pressed", "false");
      if (pressed) {
        clearHighlight();
      } else {
        btn.setAttribute("aria-pressed", "true");
        highlightBody(item, m.obj.id);
      }
    });
    chips.appendChild(btn);
  }
}

/* Ring EVERY body in the frame at once, in whichever overlay this mode
 * uses. highlightBody() and highlightInCompare() each clear their layer
 * before drawing, because they exist to show one thing; these keep what is
 * already there and add to it. */
function highlightAll(item) {
  const matches = computeInFrame(item);
  if (!matches.length) return;
  if (state.mode === "compare") {
    clearCompareHighlight();
    for (const m of matches) highlightInCompare(item, m, true);
    return;
  }
  clearHighlight();
  for (const m of matches) highlightBody(item, m.obj.id, true);
}

function clearCompareHighlight() {
  const el = document.querySelector(".cs-annotations");
  if (el) el.innerHTML = "";
}

/* Highlight a body inside the compare slider.
 *
 * computeInFrame() reports positions in the ORIGINAL image's pixel space,
 * which for an ordinary slide is fine because the stage turns image and
 * overlay together. The compare overlay is different: it sits OUTSIDE
 * `.cs-turn`, in screen space, so when the picture is turned the overlay
 * has to turn the coordinates itself.
 *
 * Read the turn off the element rather than inferring it from pixel
 * dimensions. It used to be inferred — publish.py rotated some pair
 * members' pixels and the code compared the shipped size against the WCS
 * size to spot it — but publish does not rotate anything any more, and a
 * quarter turn that exists only as a CSS transform is invisible to that
 * test. `.is-turned` is set by the same code that applies the transform,
 * so the two cannot disagree.
 */
function highlightInCompare(item, match, keep = false) {
  const wrap = document.querySelector(".compare-slider");
  if (!wrap) return;
  let layer = wrap.querySelector(".cs-annotations");
  if (!layer) {
    layer = document.createElement("div");
    layer.className = "cs-annotations";
    wrap.appendChild(layer);
  }
  const shown = wrap.querySelector(".cs-after") || wrap.querySelector(".cs-before");
  const wcs = ASTAP_CACHE[item.path]?.result;
  if (!shown || !wcs || !Array.isArray(wcs.image_size)) return;
  let xPct = match.xPct, yPct = match.yPct;
  // A quarter turn CLOCKWISE sends (x, y) to (maxY - y, x).
  if (wrap.classList.contains("is-turned")) {
    const t = xPct; xPct = 100 - yPct; yPct = t;
  }
  const dot = document.createElement("div");
  dot.className = "cs-annot-dot";
  dot.style.left = `${xPct}%`;
  dot.style.top = `${yPct}%`;
  dot.innerHTML = `<span>${escapeHtml(tId(match.obj.id))}</span>`;
  if (!keep) layer.innerHTML = "";
  layer.appendChild(dot);
}

function clearHighlight() {
  const layer = $("#slide-annotations");
  if (layer) layer.innerHTML = "";
}

// Draw a single body's circle + name label on the annotations layer.
// Coord math mirrors the old wireframe path, but only one shape is
// rendered — the one the user actually asked about.
function highlightBody(item, objId, keep = false) {
  const layer = $("#slide-annotations");
  const img = $("#slide-img");
  if (!layer || !img || !img.naturalWidth) return;
  if (!keep) layer.innerHTML = "";
  const wcs = ASTAP_CACHE[item.path]?.result;
  if (!wcs || !wcs.solved) return;
  const matches = computeInFrame(item);
  const m = matches.find(mm => mm.obj.id === objId);
  if (!m) return;

  const W = img.naturalWidth, H = img.naturalHeight;
  const wcsW = Array.isArray(wcs.image_size) ? wcs.image_size[0] : W;
  const wcsH = Array.isArray(wcs.image_size) ? wcs.image_size[1] : H;
  const stage = $("#slide-stage");
  const sW = stage.clientWidth, sH = stage.clientHeight;
  const imgRatio = W / H, stageRatio = sW / sH;
  let contentW, contentH, contentL, contentT;
  if (imgRatio > stageRatio) {
    contentW = sW; contentH = sW / imgRatio; contentL = 0; contentT = (sH - contentH) / 2;
  } else {
    contentH = sH; contentW = sH * imgRatio; contentL = (sW - contentW) / 2; contentT = 0;
  }
  const px = contentL + (m.xPct / 100) * contentW;
  const py = contentT + (m.yPct / 100) * contentH;
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("width", String(sW));
  svg.setAttribute("height", String(sH));
  svg.setAttribute("viewBox", `0 0 ${sW} ${sH}`);
  const r = (typeof m.rPctW === "number") ? (m.rPctW / 100) * contentW : 28;
  const circle = document.createElementNS(NS, "circle");
  circle.setAttribute("cx", String(px));
  circle.setAttribute("cy", String(py));
  circle.setAttribute("r",  String(Math.max(18, r)));
  circle.setAttribute("fill", "none");
  circle.setAttribute("stroke", "rgba(250,204,21,0.95)");
  circle.setAttribute("stroke-width", "2.4");
  circle.classList.add("slide-highlight-circle");
  svg.appendChild(circle);
  layer.appendChild(svg);

  // Label goes ABOVE the circle in SCREEN space, which is a different
  // local direction depending on whether the stage turned. On a turned
  // stage (the album's norm — a portrait frame shown landscape) screen-up
  // is local -x, so the label is pulled leftward. On an upright stage it
  // is plain local -y.
  const gapLocal = Math.max(18, r) + 14;
  const badge = document.createElement("div");
  badge.className = "slide-highlight-label";
  badge.textContent = tId(m.obj.id);
  if (stage.classList.contains("is-upright")) {
    badge.style.left = `${(px / sW) * 100}%`;
    badge.style.top  = `${((py - gapLocal) / sH) * 100}%`;
  } else {
    badge.style.left = `${((px - gapLocal) / sW) * 100}%`;
    badge.style.top  = `${(py / sH) * 100}%`;
  }
  layer.appendChild(badge);
}

// Called from paintSlide + resize. Renders the "In frame:" chip row and
// clears the annotations layer. Nothing is drawn until the user clicks a
// chip (then highlightBody paints one circle).
function drawAnnotations(item) {
  const layer = $("#slide-annotations");
  if (layer) layer.innerHTML = "";
  renderInFrameChips(item);
}

// ── Grid ────────────────────────────────────────────────────────────
/* The card's split border. Each mode the target carries owns an equal
 * slice of a conic gradient around the card, so the border itself says
 * which of the four are inside without a legend — and the slices are the
 * same colours as the buttons that select them. */
function modeBorder(subj) {
  const cols = subj.available.map(
    id => MODES.find(m => m.id === id).colour);
  if (cols.length === 1) return cols[0];
  const step = 100 / cols.length;
  const stops = cols.map((c, i) =>
    `${c} ${(i * step).toFixed(2)}% ${((i + 1) * step).toFixed(2)}%`);
  // Start at the top-left corner so a four-way split reads as one slice
  // per edge rather than one per corner.
  return `conic-gradient(from -45deg at 50% 50%, ${stops.join(", ")})`;
}

/* ── Starred ───────────────────────────────────────────────────────
 *
 * A like BUTTON was asked for. A like COUNT is what a like button usually
 * implies, and that is the thing this site cannot have: it is static, served
 * from GitHub Pages, with no server and nowhere to accept a write. Anonymous
 * writes on a public page also need moderation, rate limiting and a spam
 * story — an abuse surface this album does not currently carry.
 *
 * So the value is delivered without the backend: per-viewer favourites, kept
 * in the reader's own browser, surfaced as a "Starred" filter. It answers the
 * thing anyone actually wants from a like button on someone else's album —
 * "let me find the ones I liked again" — and it shares nothing with anyone.
 *
 * Storage is deliberately forgiving. A private window throws on write, a
 * browser with site data blocked throws on read, and the test harness stubs
 * getItem to return null: every path here has to survive all three, so a
 * corrupt or absent value degrades to "nothing starred" and never to an
 * exception. Namespaced `astrogallery.` to match the shipped language key —
 * switching prefixes would silently orphan whatever readers already have.
 */
const STAR_KEY    = "astrogallery.starred";
const STAR_SCHEMA = "astrogallery.schema";

let STARRED = new Set();

function loadStarred() {
  try {
    const raw = lsGet(STAR_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    STARRED = new Set(Array.isArray(arr) ? arr.filter(x => typeof x === "string") : []);
  } catch (e) {
    // Corrupt value: start clean rather than take the page down with it.
    STARRED = new Set();
  }
  // Written from the first release so a future migration can tell an old
  // shape from an absent one, which is the distinction that gets lost if the
  // version is added later.
  if (!lsGet(STAR_SCHEMA)) lsSet(STAR_SCHEMA, "1");
}

function isStarred(objId) { return STARRED.has(objId); }

function toggleStar(objId) {
  if (!objId) return false;
  if (STARRED.has(objId)) STARRED.delete(objId); else STARRED.add(objId);
  // If the write fails (private window), the in-memory set still works for
  // this session — the feature degrades to "until you close the tab" rather
  // than appearing to do nothing.
  lsSet(STAR_KEY, JSON.stringify([...STARRED]));
  return STARRED.has(objId);
}

/* The star on the big picture. Reflects the target on screen, and is hidden
 * for a capture, which has no object to remember. */
function renderStarButton() {
  const btn = $("#slide-star");
  if (!btn) return;
  const subj = currentSubject();
  if (state.viewingCapture || !subj) { btn.hidden = true; return; }
  btn.hidden = false;
  const on = isStarred(subj.objId);
  btn.classList.toggle("is-on", on);
  btn.textContent = on ? "★" : "☆";
  const label = on ? (I18N[LANG].unstarLabel || "Remove from starred")
                   : (I18N[LANG].starLabel   || "Add to starred");
  btn.title = label;
  btn.setAttribute("aria-label", label);
  btn.setAttribute("aria-pressed", on ? "true" : "false");
}

/* ── Sections ──────────────────────────────────────────────────────
 *
 * The grid was one flat run of cards. At 130 it is scrollable; the album
 * gains 71 images a month, and a flat run of 2,000 is not browsable at any
 * DOM cost. So cards are grouped by what the thing IS.
 *
 * Grouping on the raw `objType` does not work, and the reason is worth
 * writing down: mergeOpenNgc overwrites each object's type with the OpenNGC
 * value, which is a free-text vocabulary. Measured on this album that is 25
 * distinct strings across 95 catalogued targets — including "*", "HII
 * Region", "Cluster + Nebula", and eleven one-off spectral variants like
 * "Star (F7Ib supergiant)". Sectioning on it gives 25 sections, most holding
 * one card, which is worse than the flat list it replaced.
 *
 * TYPE_RULES is an ORDERED list, not a lookup table, because the overlaps
 * are real and the order is the only thing resolving them:
 *
 *   "Planetary Nebula"     must not fall to the /planet/ rule
 *   "Star Cloud"           must not fall to the /^star/ rule
 *   "Open Cluster + Nebula" must not fall to the /open cluster/ rule
 *
 * Each of those is pinned by a test, so a reordering fails loudly instead of
 * quietly moving cards.
 */
const TYPE_RULES = [
  // First, so FAMILY_TYPE resolves from the string alone and not only from
  // the `isFamily` flag above. Nothing else in this list would catch it, so
  // without this rule `canonicalType("Family photo")` answers "other" while
  // `canonicalType("Family photo", famObj)` answers "family" — one function
  // giving two answers about the same target, which is the shape of bug the
  // ordered-rules comment above is warning about.
  [/^family\b/i,                                            "family"],
  [/planetary\s*nebula/i,                                   "planetary"],
  [/supernova\s*remnant/i,                                  "remnant"],
  [/star\s*cloud|sky\s*field|constellation|galactic\s*region|milky\s*way/i,
                                                            "field"],
  [/\+\s*nebula|nebula\s*\+/i,                              "nebula"],
  [/globular/i,                                             "globular"],
  [/open\s*cluster|asterism|stellar\s*association|cluster/i, "cluster"],
  [/galaxy/i,                                               "galaxy"],
  [/nebula|hii\s*region/i,                                  "nebula"],
  [/planet|moon|sun\b|comet|asteroid/i,                     "solar"],
  [/^\s*\*\s*$|^star\b|double\s*star|binary|variable/i,     "star"],
];

/* Render order is an editorial decision, so it is declared rather than
 * falling out of insertion order. "other" is last and is a catch-all: a type
 * this file has never seen still lands somewhere, which is the guarantee a
 * separate sections.json was going to buy and does not need to. */
/* Section order, top to bottom. "family" leads because a family photo is
 * the deepest thing the album has and because it is the section a reader
 * has no other way to find — every other heading here is a kind of object
 * they already knew to look for. */
const TYPE_SECTIONS = ["family",
                       "galaxy", "nebula", "planetary", "remnant", "cluster",
                       "globular", "star", "solar", "field", "other"];

/* `obj` is optional: the catalogue entry, when the caller has it.
 *
 * It is consulted for one thing. An object the album's own catalogue files
 * under "Solar System" belongs in the Solar System section whatever its
 * type string says — and the Sun's type string says "Star", which is
 * correct and which put it beside Vega and Polaris rather than beside the
 * Moon and the planets, in a section named for it. The type is a
 * description of what a thing IS; the catalogue is a statement about where
 * it belongs, and for this one section the second is the better authority.
 */
function canonicalType(objType, obj) {
  // A family is not a kind of object, so no type string can classify it —
  // it is a statement about a photograph. Checked first, and off the flag
  // rather than off FAMILY_TYPE, so the label stays free to be prose.
  if (obj && obj.isFamily) return "family";
  if (obj && obj.catalog === "Solar System") return "solar";
  const t = String(objType || "");
  for (const [re, key] of TYPE_RULES) if (re.test(t)) return key;
  return "other";
}

/* Collapsed/expanded state lives at module scope, NOT in the DOM.
 *
 * applyLanguage() calls renderGrid(), so anything kept on an element is
 * thrown away every time the reader flips language. CLOG_OPEN_ITEMS is the
 * existing precedent for exactly this and these follow it. */
let GRID_COLLAPSED = new Set();   // sections the reader folded shut
let GRID_EXPANDED  = new Set();   // sections where "show all" was pressed

/* Past this many cards in one section, only the first page renders and the
 * rest sit behind "show all". The cap bounds the DOM by
 * (sections x SECTION_PAGE), a constant — astronomy's taxonomy does not grow
 * with the album, so this is the whole scalability answer for the grid.
 *
 * It only engages past GRID_CAP_FROM cards in total. Below that the album is
 * small enough that hiding anything makes it feel emptier than it is. */
const SECTION_PAGE  = 24;
const GRID_CAP_FROM = 300;

const GRID_FILTERS = {
  constellation: "",
  conditioned: false,
  deep: false,
  starred: false,
};
const DEEP_SECONDS = 30 * 60;

function subjectDeepest(subj) {
  return MODE_IDS.flatMap(k => subj.modes[k] || [])
    .reduce((b, x) => Math.max(b, totalExposure(x)), -1);
}

/* Does this subject survive the filter row? Separate from the text query so
 * each can be reasoned about — and tested — on its own. */
function subjectPassesFilters(subj) {
  const f = GRID_FILTERS;
  if (f.constellation && (subj.objConstellation || "") !== f.constellation)
    return false;
  if (f.conditioned && !subj.available.includes("conditioned")) return false;
  if (f.deep && subjectDeepest(subj) < DEEP_SECONDS) return false;
  if (f.starred && !isStarred(subj.objId)) return false;
  return true;
}

/* The text query. Pulled out of renderGrid so gridRenderPlan stays pure. */
function subjectMatchesQuery(subj, q) {
  if (!q) return true;
  const it = subj.coverItem || modeItem(subj, subj.available[0]);
  if (!it) return false;
  const squish = (x) => x.replace(/\s+/g, "");
  let hay = `${subj.objId} ${subj.objName} ${it.objId} ${it.objName} ${it.objType || ""} ${it.objConstellation || ""} ${(it.obj?.aliases || []).join(" ")}`;
  /* Every member's own vocabulary belongs to the family.
   *
   * The in-frame sweep below already reaches most of it, since a family
   * exists precisely because its members are all in the frame — but only
   * for a photograph with a plate solve, and a family declared by hand may
   * have none. Searching "Trifid" has to find the family whether or not
   * ASTAP got to it, so the members are stated rather than inferred. */
  for (const m of (subj.members || [])) {
    hay += ` ${m.id} ${m.name || ""} ${(m.aliases || []).join(" ")}`;
    hay += ` ${tId(m.id)} ${tName(m.name || m.id)}`;
  }
  // And the other direction: a member's own card answers its family's
  // name, so searching "Lagoon & Trifid" turns up both halves of it.
  for (const f of (subj.families || [])) hay += ` ${f.objName}`;
  const seenBody = new Set();
  for (const m of MODE_IDS.flatMap(k => subj.modes[k] || [])) {
    for (const fr of computeInFrame(m)) {
      if (seenBody.has(fr.obj.id)) continue;
      seenBody.add(fr.obj.id);
      hay += " " + fr.obj.id + " " + (fr.obj.name || "") + " " + (fr.obj.aliases || []).join(" ");
    }
  }
  // The haystack above is raw English out of the catalogue, so a reader with
  // the interface in Japanese searching a translated type matched nothing at
  // all — the album looked empty for the word it was showing them. (This
  // makes the haystack language-dependent: anything that memoises it must
  // key on LANG.)
  hay += ` ${tType(it.objType)} ${tName(it.objName)} ${tId(it.objId)}`;
  hay = hay.toLowerCase();
  return hay.includes(q) || squish(hay).includes(squish(q));
}

/* The sentence under the Family Photos heading. ONE sentence.
 *
 * It used to be three, each appended only when true of the album: the rule,
 * then an exception taking the rule back for the hand-declared families
 * below the floor, then a measured "about 80x — a median of 4.7 h against
 * 3.5 min". All three were accurate. Together they spent a paragraph of the
 * album's own bookkeeping on two facts a reader actually needs: more than
 * one subject, and a long exposure.
 *
 * `{h}` still comes from data/families.json, so the threshold on screen is
 * the threshold that ran and the two cannot drift apart.
 *
 * The hedge does the work the exception sentence used to. "usually {h} or
 * more" stays true above a 2 h 11 m M 31 + M 110 card, where a flat "{h} or
 * more" was simply wrong — so the exception no longer needs its own
 * sentence, and no branch here can leave a false claim on screen.
 *
 * familyDepthComparison() is deliberately still called nowhere in this
 * function: the depth multiple is no longer PRINTED, so there is nothing
 * left to verify at render time. The harness still measures it, because
 * "family photos really are the deeper ones" remains a property of the
 * album worth failing on — it is just not a sentence any more.
 */
function familyNoteText() {
  const dict = I18N[LANG];
  const pick = (k) => dict[k] || I18N.en[k] || "";
  const floorH = Number((FAMILIES.rule || {}).minIntegrationHours);
  const floor = formatExposure(isFinite(floorH) && floorH > 0
    ? floorH * 3600 : 0) || `4 ${tUnit("h")}`;
  return pick("familyNote").replace("{h}", floor);
}

/* Decide what the grid shows. Pure: no DOM, no side effects.
 *
 * Returns
 *   view   flat list of subjects in render order, INCLUDING ones hidden by
 *          a collapse or a page cap — this is what the arrows walk, because
 *          folding a section away is display, not intent
 *   rows   what renderGrid iterates: section markers, separator, subjects
 *   counts per-section {total, shown}
 *
 * Splitting the decision from the DOM is what makes sectioning testable at
 * all: every interesting assertion here is about a plain object.
 */
function gridRenderPlan(subjects, q) {
  const matched = subjects.filter(
    s => subjectPassesFilters(s) && subjectMatchesQuery(s, q));

  // The "new this week" band survives, as a section that sorts first. It is
  // suppressed under a query, as before: once the reader is hunting a
  // specific object across the whole catalogue, "new" stops meaning
  // anything.
  /* Where a subject sits in the new-arrivals band, or -1.
   *
   * NEW_OBJECT_IDS is written by tools/deposit_band.py from the album's
   * CATALOGUE ids, so it can never contain a family id — and a family
   * matched on its own id would be excluded from the band on the very
   * night it arrived. Which is precisely backwards: a family exists
   * because the frame carried hours of integration, so it is the least
   * likely thing in the drop to be worth hiding. A family takes the
   * earliest band position any of its members holds. */
  const bandAt = (s) => {
    let at = NEW_OBJECT_IDS.indexOf(s.objId);
    for (const m of (s.members || [])) {
      const i = NEW_OBJECT_IDS.indexOf(m.id);
      if (i >= 0 && (at < 0 || i < at)) at = i;
    }
    return at;
  };
  const newItems = [], rest = [];
  for (const s of matched) {
    ((!q && bandAt(s) >= 0 && s.isNew) ? newItems : rest).push(s);
  }
  if (newItems.length) newItems.sort((a, b) => bandAt(a) - bandAt(b));

  const bySection = new Map();
  for (const s of rest) {
    const k = canonicalType(s.objType, s.obj);
    (bySection.get(k) || bySection.set(k, []).get(k)).push(s);
  }

  const capping = matched.length > GRID_CAP_FROM;
  const rows = [], view = [], counts = {};

  for (const s of newItems) { rows.push(s); view.push(s); }
  if (newItems.length && rest.length) {
    rows.push({ __separator: true, count: newItems.length });
  }

  for (const key of TYPE_SECTIONS) {
    const list = bySection.get(key);
    if (!list || !list.length) continue;
    // A query is intent and beats a fold: a card that matches what someone
    // typed is never hidden inside a collapsed section.
    const collapsed = !q && GRID_COLLAPSED.has(key);
    const capped = capping && !GRID_EXPANDED.has(key) && list.length > SECTION_PAGE;
    const shown = collapsed ? 0 : (capped ? SECTION_PAGE : list.length);
    counts[key] = { total: list.length, shown };
    rows.push({ __section: true, key, total: list.length, shown, collapsed });
    // Everything in the section is navigable even when it is not drawn.
    for (const s of list) view.push(s);
    // Collapsed sections build NO tiles. That makes a large album cheaper to
    // render, not merely tidier to look at.
    for (let i = 0; i < shown; i++) rows.push(list[i]);
    if (shown && shown < list.length) {
      rows.push({ __more: true, key, total: list.length, shown });
    }
  }
  return { view, rows, counts, matched: matched.length };
}

/* ── Filter row ────────────────────────────────────────────────────
 *
 * Rebuilt on every language flip, so the labels are written here rather than
 * in the HTML. The constellation list is derived from the album, not from a
 * fixed table: offering a constellation with nothing behind it is a dead end
 * a reader has to discover by trying it.
 */
function renderFilters() {
  const dict = I18N[LANG];
  const sel = $("#filter-constellation");
  if (sel) {
    const cons = [...new Set(state.subjects
      .map(s => s.objConstellation).filter(Boolean))].sort();
    const cur = GRID_FILTERS.constellation;
    sel.innerHTML = `<option value="">${escapeHtml(dict.allConstellations || "All constellations")}</option>`
      + cons.map(c => `<option value="${escapeAttr(c)}">${escapeHtml(c)}</option>`).join("");
    // Restore the selection — but only if that constellation still exists,
    // so a filter cannot survive as an invisible, unclearable narrowing.
    sel.value = cons.includes(cur) ? cur : "";
    if (sel.value !== cur) GRID_FILTERS.constellation = sel.value;
  }
  const chips = [["conditioned", dict.fConditioned || "Conditioned"],
                 ["deep",        dict.fDeep        || "30 min+"],
                 ["starred",     dict.fStarred     || "★ Starred"]];
  for (const [key, label] of chips) {
    const el = $("#filter-" + key);
    if (!el) continue;
    el.textContent = label;
    const on = !!GRID_FILTERS[key];
    el.classList.toggle("is-on", on);
    el.setAttribute("aria-pressed", on ? "true" : "false");
  }
  const clear = $("#filter-clear");
  if (clear) {
    clear.textContent = dict.fClear || "Clear";
    clear.hidden = !filtersActive();
  }
}

function filtersActive() {
  return !!(GRID_FILTERS.constellation || GRID_FILTERS.conditioned
            || GRID_FILTERS.deep || GRID_FILTERS.starred);
}

function clearFilters() {
  GRID_FILTERS.constellation = "";
  GRID_FILTERS.conditioned = false;
  GRID_FILTERS.deep = false;
  GRID_FILTERS.starred = false;
}

function wireFilters() {
  const sel = $("#filter-constellation");
  if (sel) sel.addEventListener("change", () => {
    GRID_FILTERS.constellation = sel.value || "";
    renderFilters();
    renderGrid();
  });
  for (const key of ["conditioned", "deep", "starred"]) {
    const el = $("#filter-" + key);
    if (!el) continue;
    el.addEventListener("click", () => {
      GRID_FILTERS[key] = !GRID_FILTERS[key];
      // A cap opened by hand belongs to the list that was on screen when it
      // was opened; a new filter is a new list.
      GRID_EXPANDED.clear();
      renderFilters();
      renderGrid();
    });
  }
  const clear = $("#filter-clear");
  if (clear) clear.addEventListener("click", () => {
    clearFilters();
    GRID_EXPANDED.clear();
    renderFilters();
    renderGrid();
  });
}

/* Search, debounced.
 *
 * `input -> renderGrid` was raw. Each keystroke rebuilds every tile, and at
 * 2,000 cards that is a ~25,000-node rebuild per character. The count still
 * updates synchronously so typing visibly registers; only the expensive DOM
 * work waits.
 */
const SEARCH_DEBOUNCE_MS = 150;
let searchTimer = null;

function wireSearch() {
  const box = $("#search");
  if (!box) return;
  box.addEventListener("input", () => {
    // Immediate, cheap feedback: the count, without touching the grid.
    const q = (box.value || "").trim().toLowerCase();
    const plan = gridRenderPlan(state.subjects, q);
    const el = $("#gallery-count");
    if (el) el.textContent =
      `${plan.matched}${I18N[LANG].countJoiner}${state.subjects.length}`;
    if (searchTimer !== null) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { searchTimer = null; renderGrid(); },
                             SEARCH_DEBOUNCE_MS);
  });
  // Committing a search must never wait on the debounce.
  box.addEventListener("change", () => renderGrid());
  box.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { box.value = ""; renderGrid(); }
    if (e.key === "Enter")  renderGrid();
  });
}

/* Grid cards arrive from the side they sit on and settle as they scroll
 * into view.
 *
 * Three things this has to avoid:
 *
 *  - Animating the same card twice. The grid is torn down and rebuilt on
 *    every search keystroke, every filter and every section toggle, so a
 *    card that has already been shown is left plain rather than flying in
 *    again underneath the typing.
 *  - Fighting the hover lift. `.tile:hover` sets a transform of its own at
 *    the same specificity as anything two classes could say here, so the
 *    reveal classes are REMOVED once the transition ends and the card goes
 *    back to being an ordinary tile with its 120ms hover.
 *  - Layout thrash. The direction depends on where the card sits, which
 *    means measuring; every read happens in one pass over the batch before
 *    any of the writes.
 */
/* Where a card is in its arrival, from where it is on the screen.
 *
 * 0 while its top edge is still at or below the bottom of the window, 1
 * once that edge has risen to REVEAL_END of the way up it, and the eased
 * ramp in between. Anything above that is home; anything below has not
 * started. Pure arithmetic on a rectangle and a viewport height, so it can
 * be checked without a browser.
 *
 * Being a function of position rather than a trigger is the whole point:
 * scrolling up walks it backwards, scrolling down walks it forwards again,
 * and a card has no memory of having arrived before.
 */
const REVEAL_START = 1.0;    // card top level with the bottom of the window
const REVEAL_END = 0.62;     // …risen to 62% of the way up it

function revealProgress(top, vh) {
  if (!(vh > 0)) return 1;
  const t = (REVEAL_START - top / vh) / (REVEAL_START - REVEAL_END);
  const p = Math.max(0, Math.min(1, t));
  // Smoothstep, not an ease-out. This is driven by the scroll rather than
  // by a clock, so the middle of the travel should track the finger and
  // only the two ends want softening. An ease-out curve put the card 87%
  // of the way in by the halfway point, which read as it having arrived
  // before you had actually scrolled to it.
  return p * p * (3 - 2 * p);
}

/* Only the cards near the window are worth recomputing, so an observer
 * keeps that set and the scroll handler walks it. A card leaving the set
 * is pinned at whichever end it left by — arrived if it went off the top,
 * waiting if it dropped off the bottom — so the ones being skipped are
 * still correct. */
const REVEAL_NEAR = new Set();
let tileObserver = null;
let revealRaf = 0;

/* Place a set of cards from where they currently are. Both the progress
 * and the direction are written here, because both depend on the layout:
 * the column count changes with the window, and a card that was in the
 * left half at one width is in the right half at another. */
function revealPlace(tiles) {
  if (!tiles.length) return;
  const vh = window.innerHeight || 1;
  const mid = (window.innerWidth || 0) / 2;
  // Every read first, then every write. Interleaving them would make each
  // card force its own layout, which is the difference between one
  // reflow per frame and forty.
  const boxes = tiles.map(t => t.getBoundingClientRect());
  tiles.forEach((t, i) => {
    const b = boxes[i];
    t.style.setProperty("--reveal-dx",
      (b.left + b.width / 2 < mid ? -54 : 54) + "px");
    t.style.setProperty("--reveal-p", revealProgress(b.top, vh).toFixed(4));
  });
}

function revealPaint() {
  revealRaf = 0;
  if (REVEAL_NEAR.size) revealPlace([...REVEAL_NEAR]);
}

function revealSoon() {
  if (revealRaf) return;
  revealRaf = requestAnimationFrame(revealPaint);
}

function revealTiles(tiles) {
  if (!tiles.length) return;
  const reduce = typeof window !== "undefined" && window.matchMedia
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  // No observer, or motion turned down: the cards are simply there. The
  // stylesheet keeps the faint state behind the same media query, so
  // nothing here can strand a card part-way in.
  if (reduce || typeof IntersectionObserver === "undefined") return;
  if (!tileObserver) {
    tileObserver = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          REVEAL_NEAR.add(e.target);
        } else {
          // Pinned at whichever end it left by — arrived if it went off
          // the top, still waiting if it dropped off the bottom — so the
          // cards no longer being recomputed are nonetheless correct.
          REVEAL_NEAR.delete(e.target);
          e.target.style.setProperty("--reveal-p",
            e.boundingClientRect.top < 0 ? "1" : "0");
        }
      }
      revealPaint();
    // A generous margin so a card is already being tracked by the time any
    // of its ramp is on screen, and is not dropped the instant it leaves.
    }, { rootMargin: "25% 0px 25% 0px" });
    window.addEventListener("scroll", revealSoon, { passive: true });
    window.addEventListener("resize", revealSoon);
  }
  // The grid is torn down and rebuilt on every search keystroke, filter and
  // section toggle, so everything being watched right now is a detached node
  // that will never intersect anything again. Dropped rather than left to
  // accumulate across a session of typing.
  tileObserver.disconnect();
  REVEAL_NEAR.clear();
  for (const t of tiles) {
    t.classList.add("tile-reveal");
    tileObserver.observe(t);
  }
  // Place every card from where it actually is, now, rather than waiting
  // for the observer's first callback: that is delivered asynchronously,
  // and until it arrives every card sits at the stylesheet's default of
  // "not started" — so the ones already on screen would spend a frame or
  // two faint before being corrected.
  revealPlace(tiles);
}

function renderGrid() {
  if (typeof searchTimer !== "undefined" && searchTimer !== null) {
    clearTimeout(searchTimer);
    searchTimer = null;
  }
  const grid = $("#grid");
  grid.innerHTML = "";
  const q = ($("#search").value || "").trim().toLowerCase();
  const plan = gridRenderPlan(state.subjects, q);
  state.filtered = plan.view;
  // The arrows walk what the grid is showing, so filtering to galaxies and
  // pressing right no longer lands on an open cluster.
  state.view = plan.view;
  // state.subject is a POSITION in that list, and the list just changed, so
  // the position now names a different object. Re-anchor on the identity the
  // viewer is actually looking at. Without this, typing one character into
  // the search box slides the big picture onto whatever happens to sit at
  // the same index — the target changes under a keystroke that was only
  // meant to filter the grid.
  if (state.subjectId) {
    const at = state.view.findIndex(x => x.objId === state.subjectId);
    // Not in the filtered view: keep showing it and leave state.subject
    // alone. Filtering the grid must not yank the picture away from someone
    // mid-read; the arrows will re-enter the view on the next press.
    if (at >= 0) state.subject = at;
  }
  $("#gallery-count").textContent =
    `${plan.matched}${I18N[LANG].countJoiner}${state.subjects.length}`;
  const renderOrder = plan.rows;
  const made = [];
  for (const it of renderOrder) {
    if (it && it.__separator) {
      const bar = document.createElement("div");
      bar.className = "grid-separator";
      bar.setAttribute("role", "separator");
      bar.setAttribute("aria-label", I18N[LANG].newBarLabel || "New this week");
      bar.innerHTML = `
        <span class="grid-separator-label">${escapeHtml(I18N[LANG].newBarLabel || "New")}</span>
        <span class="grid-separator-line" aria-hidden="true"></span>`;
      grid.appendChild(bar);
      continue;
    }
    if (it && it.__section) {
      // One header per section: a chevron, the translated name, and how many
      // are inside. The whole header is the button — a chevron alone is a
      // small target on a phone, and there is nothing else in the row to
      // click by accident.
      const head = document.createElement("button");
      head.type = "button";
      head.className = "grid-section" + (it.collapsed ? " is-collapsed" : "");
      head.setAttribute("aria-expanded", it.collapsed ? "false" : "true");
      const names = I18N[LANG].sections || I18N.en.sections || {};
      head.innerHTML = `
        <span class="grid-section-chevron" aria-hidden="true">${it.collapsed ? "▸" : "▾"}</span>
        <span class="grid-section-name">${escapeHtml(names[it.key] || it.key)}</span>
        <span class="grid-section-count">${escapeHtml(String(it.total))}</span>
        <span class="grid-section-line" aria-hidden="true"></span>`;
      head.addEventListener("click", () => {
        if (GRID_COLLAPSED.has(it.key)) GRID_COLLAPSED.delete(it.key);
        else GRID_COLLAPSED.add(it.key);
        renderGrid();
      });
      grid.appendChild(head);
      // Families are the one section whose heading does not explain itself
      // — every other one names a kind of object the reader already knows.
      // The note says what a family photo is and what it costs in
      // integration, which is the whole reason the section exists.
      if (it.key === "family" && !it.collapsed) {
        const note = document.createElement("p");
        note.className = "grid-section-note";
        note.textContent = familyNoteText();
        grid.appendChild(note);
      }
      continue;
    }
    if (it && it.__more) {
      // Capped section: say what is being withheld rather than truncating in
      // silence. A grid that quietly stops at 24 reads as "that is all there
      // is", which is the one thing it must not say.
      const more = document.createElement("button");
      more.type = "button";
      more.className = "grid-more";
      more.textContent = (I18N[LANG].showAllLabel || "Show all {t}")
        .replace("{t}", String(it.total)).replace("{n}", String(it.shown));
      more.addEventListener("click", () => {
        GRID_EXPANDED.add(it.key);
        renderGrid();
      });
      grid.appendChild(more);
      continue;
    }
    const subj = it;
    const tile = document.createElement("div");
    // Identifies the card across rebuilds, so the scroll reveal can tell a
    // card it has already shown from one arriving for the first time.
    tile.dataset.objId = subj.objId;
    tile.className = "tile" + (subj.available.length > 1 ? " tile-multi" : "")
                            + (subj.isFamily ? " tile-family" : "");
    // The split border IS the ribbon now: four colours, four things you
    // can do with this target, and no text to translate.
    tile.style.setProperty("--tile-border", modeBorder(subj));
    const dict = (I18N[LANG].modes || I18N.en.modes || {});
    tile.title = subj.available.map(m => dict[m] || m).join(" · ");
    // Deepest integration this target has, whichever mode holds it — the
    // number a viewer scanning the grid actually wants.
    const deepest = MODE_IDS.flatMap(k => subj.modes[k] || [])
      .reduce((b, x) => Math.max(b, totalExposure(x)), -1);
    const expLabel = deepest > 0
      ? `<span class="tile-exposure">⏱ ${escapeHtml(formatExposure(deepest) || "")}</span>`
      : "";
    // Say how many photographs are behind this card. 35% of targets have
    // more than one and nothing on the card admitted it, so the extras were
    // reachable but invisible — a viewer had no reason to press the stepper.
    const nImages = imageCount(subj);
    const countLabel = nImages > 1
      ? `<span class="tile-count" title="${escapeAttr(
            (I18N[LANG].imagesLabel || "{n} images").replace("{n}", nImages))}"
         >${escapeHtml(String(nImages))}<span class="tile-count-icon"
         aria-hidden="true">▣</span></span>`
      : "";
    const pips = subj.available.map((m) => {
      const def = MODES.find(x => x.id === m);
      return `<i class="tile-pip" style="--pip:${def.colour}" ` +
             `title="${escapeAttr(dict[m] || m)}"></i>`;
    }).join("");
    /* A family card says so on its face, and names who is in it.
     *
     * Without the member line the card is just a picture with an unfamiliar
     * two-part title, and a reader who searched for the Trifid and landed
     * on "Lagoon Nebula & Trifid Nebula" would still have to open it to
     * find out whether that means what they hoped. */
    const fdict = I18N[LANG];
    const famBadge = subj.isFamily
      ? `<span class="tile-family-ribbon">${escapeHtml(
            fdict.familyBadge || I18N.en.familyBadge)}</span>`
      : "";
    const famMembers = (subj.isFamily && (subj.members || []).length)
      ? `<span class="tile-family-members">${
            subj.members.map(m => `<span>${escapeHtml(tId(m.id))}</span>`)
              .join("")}</span>`
      : "";
    /* And the other direction: the member whose deepest frame graduated
     * says where it went, with the integration time attached, so the card
     * is not silently shorter than the album's own history of it.
     *
     * It lives in the label, as its last line, because .tile is a fixed
     * square — a sibling below .tile-inner would hang out of the card and
     * over the next row. The label is already an overlay with room in it,
     * and this is the same kind of thing as the exposure chip above it.
     *
     * The prose label ("Also in a family photo:") is dropped here and kept
     * for the title attribute and for the slide, where there is width for
     * it. On a 190 px card the sentence would push the family's own name
     * off the end, and the name is the part that answers the question. */
    const famBack = (!subj.isFamily && (subj.families || []).length)
      ? subj.families.map(f => {
          const d = subjectDeepest(f);
          const t = d > 0 ? ` · ${formatExposure(d) || ""}` : "";
          const full = `${fdict.familyAlsoLabel || I18N.en.familyAlsoLabel} `
                     + `${tName(f.objName)}${t}`;
          return `<button type="button" class="tile-family-link"
                     data-family="${escapeAttr(f.objId)}"
                     title="${escapeAttr(full)}"
                  ><i aria-hidden="true">◈</i>${
                    escapeHtml(tName(f.objName))}${escapeHtml(t)}</button>`;
        }).join("")
      : "";
    // Cards holding more than one photograph get a second image layer to
    // cross-fade against. A single-image card keeps exactly the markup it
    // had — no extra element, no opacity rule, nothing to go wrong.
    const cyclePaths = tileImages(subj);
    const multi = cyclePaths.length > 1;
    const imgAlt = `${escapeAttr(tName(subj.objName || subj.objId))}${
      subj.objType ? ", " + escapeAttr(tType(subj.objType)) : ""}`;
    tile.innerHTML = `
      <div class="tile-inner">
        <img loading="lazy" decoding="async"
             class="${multi ? "tile-cycle is-on" : ""}"
             src="${escapeAttr(vURL(thumbURL(subj.cover)))}"
             data-full="${escapeAttr(vURL(subj.cover))}"
             onerror="if(this.dataset.full&&this.src!==this.dataset.full){this.src=this.dataset.full;}"
             alt="${imgAlt}">
        ${multi ? `<img loading="lazy" decoding="async" class="tile-cycle"
             alt="" aria-hidden="true">` : ""}
        <span class="tile-pips" aria-hidden="true">${pips}</span>
        ${famBadge}
        <div class="tile-label">
          ${subj.isFamily ? "" :
            `<span class="id">${escapeHtml(tId(subj.objId))}</span>`}
          <span class="name">${escapeHtml(tName(subj.objName || subj.objId))}</span>
          ${expLabel}${countLabel}${famMembers}
          ${famBack ? `<span class="tile-family-also">${famBack}</span>` : ""}
        </div>
      </div>`;
    if (multi) {
      const layers = tile.querySelectorAll("img.tile-cycle");
      tile.__cycle = { paths: cyclePaths, imgs: [layers[0], layers[1]],
                       slot: 0, at: 0 };
    }
    /* The back-link is a control INSIDE a card that is itself a control,
     * so it has to stop the click reaching the card — otherwise pressing
     * "Lagoon & Trifid" on M 8's card opens M 8, which is the one thing
     * the link exists not to do. */
    for (const link of tile.querySelectorAll(".tile-family-link")) {
      link.addEventListener("click", (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
        openSubjectById(link.dataset.family);
      });
    }
    tile.addEventListener("click", () => {
      // Open on the mode the card previewed, so the picture does not
      // change under the click.
      // Both sides resolve it the same way now — buildSubjects picks the
      // cover, showSubject picks the mode, and both ask for the deepest —
      // so there is nothing left to pass.
      slideshowStop();
      const at = navList().indexOf(subj);
      const shown = tile.__cycle
        ? (tile.__cycle.paths[tile.__cycle.at] || {}).mode : null;
      showSubject(at >= 0 ? at : 0, shown || null);
      // scrollIntoView on the slideshow is more reliable than window.scrollTo
      // — the latter silently no-ops in some browsers when the scroll root
      // isn't <html>. This lands the slide right at the top of the viewport.
      const target = $("#slideshow");
      if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
      else window.scrollTo({ top: 0, behavior: "smooth" });
    });
    grid.appendChild(tile);
    made.push(tile);
  }
  // After every card is in the document, so the measuring pass sees the
  // finished layout rather than one that is still growing.
  revealTiles(made);
  // Hold onto the live cards so the idle sleeper can restart the rotation
  // with this exact set after parking it, and reload their thumbnails after
  // unloading them (see initIdleSleep).
  gridTiles = made;
  cycleTiles(made);
}

// ── Multi-image cards cycle through their photographs ───────────────
// 35% of targets hold more than one photograph and the card showed only
// its cover. The count badge already admits there are more; this shows
// them, so the Moon's twelve are visible from the grid instead of only
// after a click.
//
// ONE timer for the whole grid, not one per card. With 145 cards a timer
// each is 145 wakeups a second mostly doing nothing, and independent
// timers drift out of phase into a flicker across the page. A single tick
// advances only the cards that are actually on screen.
const TILE_CYCLE_MS = 3800;
const TILE_CYCLE_STAGGER = 3;     // advance 1 card in N per tick, round-robin
let tileCycleTimer = null;
let tileCycleObs = null;
let tileCyclePhase = 0;
const tileCycleVisible = new Set();

// The live grid cards, and the idle sleeper's two switches. gridTiles is the
// set the rotation runs over; cycleParked says the sleeper stopped that
// rotation (so a grid rebuild must not restart it); imagesUnloaded says the
// grid's thumbnails have been blanked to reclaim their decoded memory. Both
// are cleared when the page is next used. See initIdleSleep.
let gridTiles = [];
let cycleParked = false;
let imagesUnloaded = false;

/* Every distinct photograph behind a card as {path, mode}, cover first so
 * nothing jumps on load. Deduped by path because one photograph can appear
 * under several modes (a conditioned render is both "conditioned" and half
 * of a pair) — first mode wins, and MODE_IDS order decides that.
 *
 * The mode is carried because the card's click contract is "the picture
 * does not change under the click". A cycling card can be showing
 * something other than its cover when clicked, so it opens the mode that
 * owns the frame on screen rather than always the deepest. */
function tileImages(subj) {
  const seen = new Set(), out = [];
  const coverMode = MODE_IDS.find(k =>
    (subj.modes[k] || []).some(x => x && x.path === subj.cover));
  if (subj.cover) { seen.add(subj.cover); out.push({ path: subj.cover, mode: coverMode || null }); }
  for (const k of MODE_IDS) {
    for (const x of (subj.modes[k] || [])) {
      if (x && x.path && !seen.has(x.path)) {
        seen.add(x.path);
        out.push({ path: x.path, mode: k });
      }
    }
  }
  return out;
}

// Tear the rotation all the way down: the interval that wakes the main
// thread, the observer that tracks which cards are on screen, and the
// visible-set it fills. Shared by cycleTiles (a rebuild starts fresh) and by
// the idle sleeper (a parked page runs nothing).
function stopTileCycle() {
  if (tileCycleTimer) { clearInterval(tileCycleTimer); tileCycleTimer = null; }
  if (tileCycleObs) { tileCycleObs.disconnect(); tileCycleObs = null; }
  tileCycleVisible.clear();
}

function cycleTiles(tiles) {
  // Motion is the whole feature, so with motion turned down it does not
  // run at all — the card keeps its cover, which is what it showed before.
  const reduced = window.matchMedia
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  stopTileCycle();
  if (reduced) return;
  // Parked by the idle sleeper: the grid may have just been rebuilt, but the
  // rotation was stopped on purpose and resurrecting it here would defeat
  // that. Waking the page calls cycleTiles again with the live cards.
  if (cycleParked) return;

  const live = tiles.filter(t => t && t.__cycle && t.__cycle.paths.length > 1);
  if (!live.length) return;

  tileCycleObs = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) tileCycleVisible.add(e.target);
      else tileCycleVisible.delete(e.target);
    }
  }, { rootMargin: "80px" });
  live.forEach(t => tileCycleObs.observe(t));

  tileCycleTimer = setInterval(() => {
    // Hidden tab: browsers already throttle this, but skipping outright
    // means we do not queue a burst of image loads for nobody.
    if (document.hidden) return;
    let i = 0;
    for (const tile of tileCycleVisible) {
      // Round-robin so the whole visible grid does not flip in unison,
      // which reads as the page glitching rather than as photographs.
      if ((i++ + tileCyclePhase) % TILE_CYCLE_STAGGER !== 0) continue;
      // Pointing at a card is how you ask it to hold still.
      if (tile.matches(":hover")) continue;
      advanceTile(tile);
    }
    tileCyclePhase++;
  }, TILE_CYCLE_MS);
}

function advanceTile(tile) {
  const c = tile.__cycle;
  if (!c) return;
  const next = (c.at + 1) % c.paths.length;
  if (next === c.at) return;
  const showing = c.imgs[c.slot];
  const other = c.imgs[1 - c.slot];
  const src = vURL(thumbURL(c.paths[next].path));
  // Load before showing: swapping src on a visible element paints a blank
  // frame first, which is a flash on every advance.
  const pre = new Image();
  pre.onload = () => {
    other.src = src;
    other.dataset.full = vURL(c.paths[next].path);
    other.classList.add("is-on");
    showing.classList.remove("is-on");
    c.slot = 1 - c.slot;
    c.at = next;
  };
  // A thumbnail that will not load is not worth stalling the rotation for:
  // drop that frame from this card's list and carry on.
  pre.onerror = () => {
    c.paths.splice(next, 1);
    if (c.at > next) c.at--;
  };
  pre.src = src;
}

// ── Idle sleep: give the memory back when nobody is looking ──────────
// A tab left open does two costly things forever: the card rotation keeps
// waking the main thread every few seconds to decode-and-swap thumbnails,
// and every thumbnail it has ever shown stays decoded in memory — 200-odd
// covers at a few hundred KB apiece once the browser has expanded the tiny
// JPEGs into bitmaps. Sitting on a busy album long enough, or leaving it in
// a background tab, that is tens of megabytes held for a page no one is
// watching, and the churn is what turns into scroll-jank on return.
//
// So the page sleeps. Two depths, matched to what "idle" actually means:
//
//   · Backgrounded (the tab is hidden): a DEEP sleep. Stop the rotation and
//     blank every grid thumbnail so the browser can reclaim the bitmaps.
//     Invisible by definition, and the strongest relief — this is the
//     "left in a tab for a while" case.
//
//   · Foreground but untouched for a couple of minutes: a LIGHT sleep. Stop
//     the rotation's churn, but leave the pictures on screen — the page may
//     still be glanced at, and blanking a grid someone is reading would be
//     rude. Nothing keeps waking the thread to animate thumbnails nobody is
//     watching.
//
// Any real interaction — a pointer move, a key, a scroll, or the tab coming
// back to the front — wakes it: thumbnails reload (from cache, they are a
// few KB each) and the rotation restarts. The reload is deliberately eager
// rather than lazy: 200 cached thumbnails cost less to repaint at once than
// the machinery to stream them back in would.

// 1×1 transparent GIF. Assigning it to an <img> releases whatever bitmap the
// element was holding while keeping the element laid out at its box size, and
// unlike an empty src it loads cleanly, so the tiles' onerror-to-full-res
// fallback never fires while a card is asleep.
const NAP_PIXEL =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
const IDLE_MS = 120000;   // foreground quiet before the light sleep
let idleTimer = null;
let lastArm = 0;          // throttles re-arming so pointer moves don't thrash
// Last real interaction, unthrottled. The slideshow reads it to stop itself
// once nobody has touched the page for SLIDESHOW_IDLE_MS.
let lastActivityAt = typeof performance !== "undefined" ? performance.now() : 0;

// Blank every loaded grid thumbnail, stashing its real src so waking can put
// it back. Skips the ones already blanked and the rotation's spare layer
// before it has loaded a frame (empty src) — only decoded pictures are worth
// releasing.
function unloadGridImages() {
  const grid = document.getElementById("grid");
  if (!grid) return;
  for (const img of grid.querySelectorAll("img")) {
    const cur = img.getAttribute("src");
    if (!cur || cur === NAP_PIXEL) continue;
    img.dataset.nap = cur;
    img.src = NAP_PIXEL;
  }
}

function reloadGridImages() {
  const grid = document.getElementById("grid");
  if (!grid) return;
  for (const img of grid.querySelectorAll("img[data-nap]")) {
    const src = img.dataset.nap;
    delete img.dataset.nap;
    if (src) img.src = src;
  }
}

// Backgrounded: park the rotation AND drop the bitmaps.
function sleepDeep() {
  if (!cycleParked) { stopTileCycle(); cycleParked = true; }
  if (!imagesUnloaded) { unloadGridImages(); imagesUnloaded = true; }
}

// Untouched but still on screen: park the rotation only.
function sleepLight() {
  if (document.hidden) return;            // deep sleep already owns this
  if (!cycleParked) { stopTileCycle(); cycleParked = true; }
}

function wakeGallery() {
  if (imagesUnloaded) { reloadGridImages(); imagesUnloaded = false; }
  if (cycleParked) { cycleParked = false; cycleTiles(gridTiles); }
  armIdle();
}

function armIdle() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(sleepLight, IDLE_MS);
  lastArm = performance.now();
}

// One handler for every kind of activity. If the page is asleep it wakes;
// otherwise it just pushes the light-sleep timer out, throttled so a stream
// of pointer-move events does not reset the timer thousands of times a
// second.
function noteActivity() {
  if (document.hidden) return;            // stray event behind a hidden tab
  lastActivityAt = performance.now();
  if (cycleParked || imagesUnloaded) { wakeGallery(); return; }
  const now = performance.now();
  if (now - lastArm < 1000) return;
  armIdle();
}

function onVisibility() {
  if (document.hidden) { sleepDeep(); return; }
  wakeGallery();
  // Coming back to the tab counts as being here, and a show parked while
  // hidden picks up where it stopped.
  lastActivityAt = performance.now();
  if (slideshowPaused) slideshowArm();
}

function initIdleSleep() {
  document.addEventListener("visibilitychange", onVisibility);
  for (const ev of ["pointermove", "pointerdown", "keydown", "wheel", "touchstart"]) {
    window.addEventListener(ev, noteActivity, { passive: true });
  }
  window.addEventListener("scroll", noteActivity, { passive: true });
  // A tab opened in the background never fires visibilitychange for that
  // initial state, so check it directly: sleep deep now, and the first
  // foreground moment wakes it.
  if (document.hidden) sleepDeep();
  else armIdle();
}

// ── Utils ───────────────────────────────────────────────────────────
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
function escapeAttr(s) { return escapeHtml(s); }

// ── Changelog ───────────────────────────────────────────────────────
// The panel is a timeline rather than a list. Entries are grouped into
// major-version eras (changelog.json `eras`, mirroring the major audit
// trail in data/version.json); each era is a dropdown and only the newest
// one starts open, so the whole history reads as three lines until the
// reader asks for more. Entry bodies are bullets — one fact each — which
// is the format that survives being read standing up.

// "2026-08-04" → "Aug 4" / "8月4日". Kept out of Intl.DateTimeFormat on
// purpose: parsing an ISO date as a Date shifts it a day backwards west
// of UTC, and these are calendar dates, not instants.
function clogFmtDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
  if (!m) return String(iso || "");
  const months = I18N[LANG].changelogMonths || [];
  const month = months[Number(m[2]) - 1] || m[2];
  const day = String(Number(m[3]));
  return (LANG === "ja") ? `${month}${day}日` : `${month} ${day}`;
}

function clogFmtRange(from, to) {
  if (!from && !to) return "";
  if (!from || !to || from === to) return clogFmtDate(from || to);
  return `${clogFmtDate(from)}${LANG === "ja" ? "〜" : " – "}${clogFmtDate(to)}`;
}

function clogFmtCount(n) {
  const t = I18N[LANG] || {};
  const tpl = (n === 1 && t.changelogCountOne) ? t.changelogCountOne
                                               : (t.changelogCount || "{n}");
  return String(tpl).replace("{n}", String(n));
}

// The bullets for one entry in the current language, falling back to
// English. Entries written before the timeline carried a single prose
// `body`; split those on the line breaks the author wrote rather than
// dropping a wall of text into one bullet.
function clogBullets(entry) {
  const loc = entry[LANG] || {};
  const en = entry.en || {};
  const raw = Array.isArray(loc.bullets) ? loc.bullets
            : Array.isArray(en.bullets)  ? en.bullets
            : null;
  if (raw) return raw.map(s => String(s).trim()).filter(Boolean);
  return String(loc.body || en.body || "")
    .split(/\n+/)
    .map(s => s.replace(/^[•·\-–—]\s*/, "").trim())
    .filter(Boolean);
}

// One entry: a dated node on the track whose title row opens to reveal the
// bullets. Collapsed by default — an era holding four entries has to read
// as four lines before it reads as four screens, or the timeline is just
// the old scrolling list with better punctuation.
function clogItemHTML(e, key, open) {
  const typeLabels = I18N[LANG].changelogTypes || {};
  const type = String(e.type || "").toLowerCase();
  const typeLabel = typeLabels[type] || type || "";
  const heading = (e[LANG] && e[LANG].title) || (e.en && e.en.title) || "";
  const bullets = clogBullets(e);
  return `
    <li class="clog-item ${escapeAttr(type)}">
      <details class="clog-item-box" data-key="${escapeAttr(key)}"${open ? " open" : ""}>
        <summary class="clog-item-head">
          <span class="clog-item-meta">
            <span class="clog-item-date">${escapeHtml(clogFmtDate(e.date))}</span>
            ${typeLabel ? `<span class="clog-item-type ${escapeAttr(type)}">${escapeHtml(typeLabel)}</span>` : ""}
          </span>
          <span class="clog-item-title">${escapeHtml(heading)}</span>
          <span class="clog-item-chev" aria-hidden="true">
            <svg viewBox="0 0 12 12" width="10" height="10">
              <path d="M4 2 L8 6 L4 10" fill="none" stroke="currentColor"
                    stroke-width="1.6" stroke-linecap="round"
                    stroke-linejoin="round"/>
            </svg>
          </span>
        </summary>
        ${bullets.length ? `<ul class="clog-bullets">${
          bullets.map(b => `<li>${escapeHtml(b)}</li>`).join("")
        }</ul>` : ""}
      </details>
    </li>`;
}

// Track which entries the reader opened, so a language flip re-renders the
// same view instead of folding everything back up under them.
function clogWireItems(root) {
  root.querySelectorAll("details.clog-item-box").forEach(d => {
    d.addEventListener("toggle", () => {
      if (d.open) CLOG_OPEN_ITEMS.add(d.dataset.key);
      else CLOG_OPEN_ITEMS.delete(d.dataset.key);
    });
  });
}

// Render the changelog panel from CHANGELOG. Called on boot and whenever
// the language toggle flips (localised titles, type chips, dates).
function renderChangelog() {
  const list = $("#changelog-list");
  const label = $("#changelog-label");
  const title = $("#changelog-panel-title");
  const stamp = $("#changelog-version");
  if (label) label.textContent = I18N[LANG].changelogLabel;
  if (title) title.textContent = I18N[LANG].changelogLabel;
  if (stamp) {
    const v = VERSION && VERSION.version;
    stamp.textContent = v ? `v${v}` : "";
    stamp.hidden = !v;
  }
  if (!list) return;
  list.innerHTML = "";

  // Sort newest-first (ISO dates sort lexicographically).
  const entries = [...(CHANGELOG.entries || [])].sort((a, b) =>
    String(b.date || "").localeCompare(String(a.date || "")));

  // Bucket entries into their declared eras, newest major first. An entry
  // whose `era` is missing or names an era that was never declared still
  // has to appear — those collect in a leading unbanded track instead of
  // vanishing, which also covers a changelog.json with no `eras` at all.
  const bands = [];
  const byMajor = new Map();
  for (const def of (Array.isArray(CHANGELOG.eras) ? CHANGELOG.eras : [])) {
    const major = Number(def.major);
    if (!Number.isFinite(major) || byMajor.has(major)) continue;
    const band = { major, def, items: [] };
    byMajor.set(major, band);
    bands.push(band);
  }
  bands.sort((a, b) => b.major - a.major);
  const loose = [];
  for (const e of entries) {
    const band = byMajor.get(Number(e.era));
    (band ? band.items : loose).push(e);
  }
  const filled = bands.filter(b => b.items.length);

  // First render decides what is open: the newest era, and inside it the
  // newest entry, so the panel opens showing what it is rather than a
  // stack of closed rows. After that the reader owns it, and a language
  // flip must not fold the panel back up under them.
  if (CLOG_OPEN === null) {
    CLOG_OPEN = new Set(filled.length ? [filled[0].major] : []);
    CLOG_OPEN_ITEMS = new Set(loose.length ? ["loose#0"]
                            : filled.length ? [`${filled[0].major}#0`] : []);
  }

  if (loose.length) {
    const ul = document.createElement("li");
    ul.className = "clog-era clog-era-loose";
    ul.innerHTML = `<ol class="clog-track">${loose.map((e, i) =>
      clogItemHTML(e, `loose#${i}`, CLOG_OPEN_ITEMS.has(`loose#${i}`))).join("")}</ol>`;
    clogWireItems(ul);
    list.appendChild(ul);
  }

  for (const band of filled) {
    const dates = band.items.map(e => String(e.date || "")).filter(Boolean);
    const range = clogFmtRange(dates[dates.length - 1], dates[0]);
    const eraTitle = (band.def[LANG] && band.def[LANG].title)
                  || (band.def.en && band.def.en.title) || "";
    const isNewest = band === filled[0];

    const li = document.createElement("li");
    li.className = "clog-era";
    const box = document.createElement("details");
    box.className = "clog-era-box";
    box.open = CLOG_OPEN.has(band.major);
    box.innerHTML = `
      <summary class="clog-era-head">
        <span class="clog-era-chev" aria-hidden="true">
          <svg viewBox="0 0 12 12" width="11" height="11">
            <path d="M4 2 L8 6 L4 10" fill="none" stroke="currentColor"
                  stroke-width="1.6" stroke-linecap="round"
                  stroke-linejoin="round"/>
          </svg>
        </span>
        <span class="clog-era-tag">v${escapeHtml(String(band.major))}</span>
        <span class="clog-era-text">
          <span class="clog-era-title">${escapeHtml(eraTitle)}</span>
          <span class="clog-era-meta">${escapeHtml(range)} · ${escapeHtml(clogFmtCount(band.items.length))}</span>
        </span>
        ${isNewest ? `<span class="clog-era-now">${escapeHtml(I18N[LANG].changelogCurrent || "")}</span>` : ""}
      </summary>
      <ol class="clog-track">${band.items.map((e, i) => {
        const key = `${band.major}#${i}`;
        return clogItemHTML(e, key, CLOG_OPEN_ITEMS.has(key));
      }).join("")}</ol>
    `;
    box.addEventListener("toggle", () => {
      if (box.open) CLOG_OPEN.add(band.major);
      else CLOG_OPEN.delete(band.major);
    });
    clogWireItems(box);
    li.appendChild(box);
    list.appendChild(li);
  }
}

// Compare-slider component. Two images stacked; the `after` image uses a
// gradient mask so the interface fades softly instead of clipping hard.
// The white handle disappears while a pointer holds it.
//
// Half the mask's fade width, in px. MUST match `--fade-width` on
// `.compare-slider` in gallery.css — it is duplicated here rather than read
// back with getComputedStyle because the component has to construct itself
// under the Node test harness, which stubs the DOM but has no CSS engine and
// no getComputedStyle at all.
const CS_FADE_PX = 8;
function makeCompareSlider(beforeSrc, afterSrc, labels) {
  const wrap = document.createElement("div");
  wrap.className = "compare-slider";
  wrap.setAttribute("role", "img");
  // `.cs-turn` holds the two photographs and is what gets turned a quarter
  // turn for a portrait source. The MASK stays outside it, on `.cs-after-mask`
  // — see the CSS — because the mask has to stay in screen space or the
  // divider would sweep vertically. The handle is outside it for the same
  // reason.
  wrap.innerHTML = `
    <div class="cs-turn">
      <img class="cs-before" src="${escapeAttr(vURL(beforeSrc))}" alt="Before conditioning">
      <div class="cs-after-mask">
        <img class="cs-after" src="${escapeAttr(vURL(afterSrc))}" alt="After conditioning">
      </div>
    </div>
    <div class="cs-handle" tabindex="0" role="slider"
         aria-label="Drag to compare before and after"
         aria-valuemin="0" aria-valuemax="100" aria-valuenow="50">
      <span class="cs-handle-arrows" aria-hidden="true">‹›</span>
    </div>
  `;
  const turnBox = wrap.querySelector(".cs-turn");
  // Fit the slider to the source once its size is known, and TURN it if the
  // source is portrait so the comparison is always landscape.
  //
  // The album is Seestar frames, which are portrait, and the ordinary slide
  // already presents them landscape — but the slider showed them as they
  // came, so 44 of 47 comparisons were portrait while 3 were landscape
  // (publish used to pre-rotate the pixels of date-bucketed pairs only).
  //
  // The turned box has to be as wide as the wrap is TALL and as tall as the
  // wrap is WIDE. Both are percentages of the wrap's own axes — a percentage
  // width resolves against the parent's width and a percentage height
  // against its height — so given the aspect ratio the two numbers fall out
  // without measuring anything.
  const cbSet = (img) => {
    const nw = img.naturalWidth, nh = img.naturalHeight;
    if (!nw || !nh) return;
    const turned = nh > nw;
    wrap.classList.toggle("is-turned", turned);
    if (turned) {
      wrap.style.aspectRatio = `${nh} / ${nw}`;
      turnBox.style.width  = `${(nw / nh) * 100}%`;   // == the wrap's height
      turnBox.style.height = `${(nh / nw) * 100}%`;   // == the wrap's width
    } else {
      wrap.style.aspectRatio = `${nw} / ${nh}`;
      turnBox.style.width = "";
      turnBox.style.height = "";
    }
  };
  const imgBefore = wrap.querySelector(".cs-before");
  const imgAfter  = wrap.querySelector(".cs-after");
  if (imgBefore.complete) cbSet(imgBefore);
  else imgBefore.addEventListener("load", () => cbSet(imgBefore), { once: true });
  if (imgAfter.complete && !wrap.style.aspectRatio) cbSet(imgAfter);
  else imgAfter.addEventListener("load", () => {
    if (!wrap.style.aspectRatio) cbSet(imgAfter);
  }, { once: true });
  const handle = wrap.querySelector(".cs-handle");
  // Live divider position in % (also mirrored to --divider-x CSS var).
  let dividerPct = 50;
  // Velocity tracking for inertial release. We keep the last two samples
  // so we can compute a smoothed velocity even if the pointer stops
  // moving briefly before release (avoids "sudden dead" behavior).
  let lastMoveTime = 0;
  let lastMoveX = 0;
  let velocity = 0;                // percent-of-width per millisecond
  let inertiaRaf = null;

  // How far past each end the divider may travel, as a percentage of the
  // current width. The mask is a gradient CENTRED on the divider — it runs
  // from transparent at (x - fade) to opaque at (x + fade) — so stopping
  // the divider dead on 0% or 100% leaves half that gradient still inside
  // the picture: an 8 px band at the edge where the two frames are blended
  // rather than one of them being whole. It reads as a smear the slider
  // cannot push off. Letting the divider overshoot by the fade width moves
  // the whole gradient clear of the frame, so each end resolves to one
  // clean picture. Falls back to 0 before the element has been laid out.
  const overshootPct = () => {
    const w = wrap.getBoundingClientRect().width;
    if (!w) return 0;
    return (CS_FADE_PX / w) * 100;
  };
  const setDivider = (pct) => {
    const over = overshootPct();
    dividerPct = Math.max(-over, Math.min(100 + over, pct));
    wrap.style.setProperty("--divider-x", dividerPct + "%");
    // The handle stays ON the picture even while the fade runs past it,
    // so the disc never clips against the frame's overflow:hidden.
    const handlePct = Math.max(0, Math.min(100, dividerPct));
    wrap.style.setProperty("--handle-x", handlePct + "%");
    handle.setAttribute("aria-valuenow", String(Math.round(handlePct)));
  };
  const cancelInertia = () => {
    if (inertiaRaf !== null) {
      cancelAnimationFrame(inertiaRaf);
      inertiaRaf = null;
    }
  };
  const startInertia = () => {
    // Decay velocity exponentially. `damping` per frame; small threshold
    // stops the loop when motion is imperceptible. Reflects off edges
    // by clamping and killing velocity so the divider settles cleanly
    // instead of "bouncing".
    if (Math.abs(velocity) < 0.005) return;
    let lastFrameTime = performance.now();
    const step = (t) => {
      const dt = Math.min(t - lastFrameTime, 40);   // clamp to avoid huge jumps on backgrounded tabs
      lastFrameTime = t;
      // dt is in ms; velocity in %/ms → pos delta in %
      let next = dividerPct + velocity * dt;
      // Same bounds the drag uses, or inertia would stop the divider one
      // fade-width short of clean at each end.
      const over = overshootPct();
      if (next <= -over)       { next = -over;       velocity = 0; }
      if (next >= 100 + over)  { next = 100 + over;  velocity = 0; }
      setDivider(next);
      // Damping: geometric decay ≈ 0.94 per 16 ms frame → half-life ~180 ms.
      velocity *= Math.pow(0.94, dt / 16);
      if (Math.abs(velocity) < 0.005) { inertiaRaf = null; return; }
      inertiaRaf = requestAnimationFrame(step);
    };
    inertiaRaf = requestAnimationFrame(step);
  };
  const moveFromClient = (clientX) => {
    const r = wrap.getBoundingClientRect();
    const pct = ((clientX - r.left) / r.width) * 100;
    const now = performance.now();
    if (lastMoveTime > 0) {
      const dt = Math.max(1, now - lastMoveTime);
      const dPct = pct - dividerPct;
      // Blend the fresh sample with the previous velocity so a brief
      // hold-then-release doesn't zero the momentum.
      velocity = 0.6 * (dPct / dt) + 0.4 * velocity;
    }
    lastMoveTime = now;
    lastMoveX = clientX;
    setDivider(pct);
  };
  let activePointerId = null;
  const onDown = (e) => {
    if (activePointerId !== null) return;
    activePointerId = e.pointerId ?? "mouse";
    wrap.dataset.dragging = "true";
    wrap.setPointerCapture?.(e.pointerId);
    cancelInertia();
    velocity = 0;
    lastMoveTime = performance.now();
    lastMoveX = e.clientX;
    setDivider(((e.clientX - wrap.getBoundingClientRect().left) /
                 wrap.getBoundingClientRect().width) * 100);
    e.preventDefault();
  };
  const onMove = (e) => {
    if (activePointerId === null) return;
    if (e.pointerId !== undefined && e.pointerId !== activePointerId) return;
    moveFromClient(e.clientX);
  };
  const onUp = (e) => {
    if (activePointerId === null) return;
    if (e.pointerId !== undefined && e.pointerId !== activePointerId) return;
    activePointerId = null;
    wrap.dataset.dragging = "false";
    // Decay any recent velocity so the divider glides to rest.
    startInertia();
  };
  wrap.addEventListener("pointerdown", onDown);
  wrap.addEventListener("pointermove", onMove);
  wrap.addEventListener("pointerup", onUp);
  wrap.addEventListener("pointercancel", onUp);
  wrap.addEventListener("pointerleave", (e) => {
    // If the finger/mouse leaves the container mid-drag, keep the drag
    // alive until pointerup fires globally (still captured); if capture
    // is unsupported (older browsers), stop on leave.
    if (activePointerId !== null && !wrap.hasPointerCapture?.(e.pointerId)) onUp(e);
  });
  // Keyboard support — arrow keys nudge the divider by 5%.
  handle.addEventListener("keydown", (e) => {
    const now = parseFloat(handle.getAttribute("aria-valuenow")) || 50;
    if (e.key === "ArrowLeft")  { setDivider(now - 5); e.preventDefault(); }
    if (e.key === "ArrowRight") { setDivider(now + 5); e.preventDefault(); }
    // ±Infinity so these land on the true ends — setDivider clamps to the
    // overshot bounds, and 0/100 would stop a fade-width short of clean.
    if (e.key === "Home")       { setDivider(-Infinity); e.preventDefault(); }
    if (e.key === "End")        { setDivider(Infinity);  e.preventDefault(); }
  });
  setDivider(50);
  return wrap;
}

// Apply LANG to every user-visible string outside the ephemeral slide caption.
// Called on boot and whenever the toggle flips.
function applyLanguage() {
  document.documentElement.lang = LANG;
  const dict = I18N[LANG];
  document.title = dict.title;
  const title = $("#hdr-title");
  if (title) title.textContent = dict.title;
  const search = $("#search");
  if (search) search.placeholder = dict.searchPlaceholder;
  const footer = document.querySelector(".ftr span");
  if (footer) footer.innerHTML = dict.footer;
  const disc = $("#slide-disclaimer");
  if (disc) disc.textContent = dict.disclaimer;
  const btn = $("#lang-toggle");
  // Button shows the OTHER language (what you'll get if you click).
  if (btn) btn.textContent = LANG === "en" ? I18N.ja.langLabel : I18N.en.langLabel;
  const domeLbl = $("#dome-label");
  if (domeLbl) domeLbl.textContent = dict.domeLabel;
  const domeBtn = $("#dome-toggle");
  if (domeBtn) domeBtn.title = dict.domeTitle;
  const domeHint = $("#dome-hint");
  if (domeHint) domeHint.textContent = dict.domeHint;
  const notice = $("#pipeline-notice");
  if (notice) notice.textContent = dict.pipelineNotice;
  if (state.subjects.length) {
    // Filter labels before the grid: renderGrid reads GRID_FILTERS, and
    // renderFilters can clear a constellation that no longer exists.
    renderFilters();
    paintSlide();
    renderGrid();
  }
  renderChangelog();
}

// ── Supporting-screenshot inline panel ──────────────────────────────
// Sibling of the (i) and (n) panels below the slide caption. Populated
// with the image (and prev/next arrows when the object has multiple
// shots). Rendering is idempotent — called on every slide change and
// whenever the user navigates within a multi-shot set.
function renderScreenshotPanel() {
  const panel = $("#slide-ss-panel");
  if (!panel || !_ssItem) return;
  const shots = (SCREENSHOTS.byObjId || {})[_ssItem.objId] || [];
  if (!shots.length) { panel.innerHTML = ""; return; }
  _ssIndex = Math.max(0, Math.min(_ssIndex, shots.length - 1));
  const nav = shots.length > 1 ? `
    <span class="ss-nav-inline">
      <button type="button" class="ss-prev" aria-label="Previous">‹</button>
      <span class="ss-counter">${_ssIndex + 1} / ${shots.length}</span>
      <button type="button" class="ss-next" aria-label="Next">›</button>
    </span>` : "";
  panel.innerHTML = `
    <div class="ss-title">
      <span>${escapeHtml(tId(_ssItem.objId))} — close-up</span>
      ${nav}
    </div>
    <img class="ss-img" src="${escapeAttr(vURL(shots[_ssIndex].path))}"
         alt="${escapeAttr(_ssItem.objId + ' close-up')}" />
  `;
  panel.querySelector(".ss-prev")?.addEventListener("click", (e) => {
    e.stopPropagation();
    _ssIndex = (_ssIndex - 1 + shots.length) % shots.length;
    renderScreenshotPanel();
  });
  panel.querySelector(".ss-next")?.addEventListener("click", (e) => {
    e.stopPropagation();
    _ssIndex = (_ssIndex + 1) % shots.length;
    renderScreenshotPanel();
  });
}

// ── Integration-time showcase ───────────────────────────────────────
// One target, the same processing, increasing exposure. The steps are
// deliberately NOT conditioned per-step: the finishing pipeline exists to
// make targets comparable to each other and drives every render to the same
// noise level regardless of integration, which would erase exactly what
// this is showing. Identical stack recipe, one white balance and one tone
// curve solved on the deepest stack and frozen for all of them.
function renderShowcasePanel() {
  const panel = $("#slide-sc-panel");
  if (!panel || !_scItem) return;
  const sc = (SHOWCASE.byObjId || {})[_scItem.objId];
  if (!sc || !sc.steps || !sc.steps.length) { panel.innerHTML = ""; return; }
  const steps = sc.steps;
  _scIndex = Math.max(0, Math.min(_scIndex, steps.length - 1));
  const cur = steps[_scIndex];
  const chips = steps.map((s, i) => `
    <button type="button" class="sc-chip${i === _scIndex ? " is-on" : ""}"
            data-i="${i}" aria-pressed="${i === _scIndex}">
      ${escapeHtml(fmtMinutes(scStepMin(steps, i)))}
    </button>`).join("");
  // Show what the stack ACHIEVED, not what was asked for — frames get
  // rejected during registration, so 30 minutes requested is never 30
  // minutes delivered.
  panel.innerHTML = `
    <div class="sc-title">${escapeHtml(I18N[LANG].showcaseTitle)}</div>
    <div class="sc-chips">${chips}</div>
    <img class="sc-img" src="${escapeAttr(vURL(cur.path))}"
         alt="${escapeAttr(_scItem.objId + " at " + fmtMinutes(scStepMin(steps, _scIndex)))}" />
    <div class="sc-caption">
      <strong>${escapeHtml(fmtMinutes(scStepMin(steps, _scIndex)))}</strong>
      ${escapeHtml(I18N[LANG].showcaseAchieved)}
      ${cur.achieved_min.toFixed(1)} min · ${cur.frames} ${escapeHtml(I18N[LANG].showcaseFrames)}
    </div>
    <div class="sc-note">${escapeHtml(sc.note || "")}</div>`;
  panel.querySelectorAll(".sc-chip").forEach(b => {
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      _scIndex = Number(b.dataset.i) || 0;
      renderShowcasePanel();
    });
  });
  // Preload neighbours so stepping through does not flash white.
  for (const j of [_scIndex - 1, _scIndex + 1]) {
    if (j >= 0 && j < steps.length) new Image().src = vURL(steps[j].path);
  }
}

// A showcase rung's label. Rungs are named by what was asked for (10 min,
// 1 h), except the LAST: it asks for "every staged sub", which is not what the
// stack keeps. NGC 6960's asked for 258 min and kept about 214, and M 8's top
// tick read 9.8 h for 570.7 min achieved. So the last rung says what it holds.
function scStepMin(steps, i) {
  const s = steps[i];
  return (i === steps.length - 1 && s.achieved_min > 0)
    ? Math.round(s.achieved_min) : s.requested_min;
}

function fmtMinutes(m) {
  if (m < 60) return `${m} min`;
  const h = m / 60;
  return Number.isInteger(h) ? `${h} h` : `${h.toFixed(1)} h`;
}

// ── Main ────────────────────────────────────────────────────────────
/* ── Your captures ───────────────────────────────────────────────────
 *
 * A capture is a photograph the viewer framed themselves: they draw a
 * rectangle on the sky dome and every image inside it is composited into
 * one, seams feathered, uncovered margin trimmed. The dome does the
 * rendering — it owns the WebGL context, the plate solves and the same
 * weighted-average compositor the map is drawn with — and announces the
 * finished image on `skydome:capture`.
 *
 * They live in the page and nowhere else. Nothing is uploaded, and a
 * reload clears them; the card says so, because a viewer who assumes
 * otherwise loses work. The download is the blob the dome already
 * encoded, so what saves is byte-for-byte what the preview shows rather
 * than a second render that could differ.
 */
const CAPTURES = [];

function captureCardHtml(c) {
  const deg = `${c.wDeg.toFixed(2)}° × ${c.hDeg.toFixed(2)}°`;
  const px = `${c.w} × ${c.h}`;
  const from = c.labels && c.labels.length
    ? `${c.frames} frame${c.frames === 1 ? "" : "s"}: `
      + escapeHtml([...new Set(c.labels)].slice(0, 4).join(", "))
      + (new Set(c.labels).size > 4 ? "…" : "")
    : `${c.frames} frame${c.frames === 1 ? "" : "s"}`;
  return `
    <figure class="capture-card" data-id="${escapeAttr(c.id)}">
      <img class="capture-img" src="${escapeAttr(c.url)}"
           alt="Sky capture, ${escapeAttr(deg)}" loading="lazy" />
      <figcaption class="capture-meta">
        <span class="capture-deg">${escapeHtml(deg)}</span>
        <span class="capture-px">${escapeHtml(px)}</span>
        <span class="capture-from">${from}</span>
        ${c.partial ? '<span class="capture-warn">some detail was still '
                      + 'loading when this was taken</span>' : ""}
      </figcaption>
      <div class="capture-actions">
        <a class="slide-download-btn solo dl-integration capture-dl"
           href="${escapeAttr(c.url)}" download="${escapeAttr(c.name)}"
           title="Download this capture">↓ Download capture</a>
        <button type="button" class="capture-remove" data-id="${escapeAttr(c.id)}"
                aria-label="Remove this capture">Remove</button>
      </div>
    </figure>`;
}

function renderCaptures() {
  const sec = $("#captures");
  const list = $("#captures-list");
  const note = $("#captures-note");
  if (!sec || !list) return;
  sec.hidden = CAPTURES.length === 0;
  if (!CAPTURES.length) { list.innerHTML = ""; return; }
  // Newest first — the one just taken is the one being looked for.
  list.innerHTML = CAPTURES.slice().reverse().map(captureCardHtml).join("");
  if (note) {
    note.textContent = "Held in this page only — a reload clears them.";
  }
  list.querySelectorAll(".capture-img").forEach((im) => {
    im.style.cursor = "pointer";
    im.addEventListener("click", () => {
      const c = CAPTURES.find((x) => x.id === im.closest(".capture-card").dataset.id);
      if (c) showCapture(c);
    });
  });
  list.querySelectorAll(".capture-remove").forEach((b) => {
    b.addEventListener("click", () => {
      const i = CAPTURES.findIndex((c) => c.id === b.dataset.id);
      if (i < 0) return;
      if (state.viewingCapture && state.viewingCapture.id === CAPTURES[i].id) {
        state.viewingCapture = null;
        showSubject(state.subject);
      }
      try { URL.revokeObjectURL(CAPTURES[i].url); } catch (_) {}
      CAPTURES.splice(i, 1);
      renderCaptures();
    });
  });
}

function wireCaptures() {
  document.addEventListener("skydome:capture", (e) => {
    const c = e.detail;
    if (!c || !c.id) return;
    CAPTURES.push(c);
    renderCaptures();
    showCapture(c);
  });
  // The dome bounds how many it holds; when it drops the oldest, the card
  // must go with it or it would point at a revoked URL.
  document.addEventListener("skydome:capture-dropped", (e) => {
    const id = e.detail && e.detail.id;
    const i = CAPTURES.findIndex((c) => c.id === id);
    if (i >= 0) { CAPTURES.splice(i, 1); renderCaptures(); }
  });
  renderCaptures();
}

async function main() {
  await loadData();
  state.items = buildItems();
  state.subjects = buildSubjects(state.items);
  // Before the first paint: renderStarButton runs inside it.
  loadStarred();
  if (state.subjects.length === 0) {
    $("#slide-name").textContent = "No photos yet.";
    return;
  }
  // Everything below this point is UI wiring — the header buttons, the
  // arrows, the search box, the bridge to the sky dome. main() runs as one
  // straight line, so anything that throws up here silently takes all of
  // it with it, and the symptom is not "the first slide looks wrong", it
  // is "the Sky button does nothing". Painting is allowed to fail; wiring
  // is not.
  try {
    showSubject(0);
    applyLanguage();  // sets initial header/placeholder/footer + first paint
  } catch (e) {
    console.error("gallery: first paint failed, continuing to wire the UI", e);
  }

  // Before anything that could throw: captures arrive on an event and the
  // listener has to exist by the time the dome fires one.
  wireCaptures();

  wireVote();
  $("#slide-prev").addEventListener("click", () => goSlide(-1));
  $("#slide-next").addEventListener("click", () => goSlide( 1));
  const fPrev = $("#slide-frame-prev"), fNext = $("#slide-frame-next");
  if (fPrev) fPrev.addEventListener("click", () => stepFrame(-1));
  if (fNext) fNext.addEventListener("click", () => stepFrame( 1));
  const blowBox = $("#slide-blowup");
  const blowClose = $("#slide-blowup-close");
  if (blowClose) blowClose.addEventListener("click", () => closeBlowup());
  // The dark surround closes too, but only when it is the surround that was
  // hit — clicking the photograph itself must not dismiss it.
  if (blowBox) {
    blowBox.addEventListener("click", (e) => {
      if (e.target === blowBox) closeBlowup();
    });
  }
  const scRange = $("#slide-sc-range");
  if (scRange) {
    scRange.addEventListener("input", () => {
      state.scPos = Number(scRange.value) || 0;
      state.scIndex = Math.round(state.scPos);
      paintSlide();
    });
  }
  // Toggle the conditioned-info (i) and author-note (n) panels. The
  // panels are siblings, so opening one closes the other for tidiness.
  // (i), (n), (s) all share the same "click icon → toggle an inline
  // panel below; opening one closes the others" pattern. Same visual
  // rhythm across the three affordances.
  const infoBtn = $("#slide-info-btn");
  const infoPanel = $("#slide-info-panel");
  const noteBtn = $("#slide-note-btn");
  const notePanel = $("#slide-note-panel");
  const ssBtn = $("#slide-ss-btn");
  const ssPanel = $("#slide-ss-panel");
  const scBtn = $("#slide-sc-btn");
  const scPanel = $("#slide-sc-panel");
  function togglePanel(btn, panel, others) {
    const open = panel.hidden;
    panel.hidden = !open;
    btn.setAttribute("aria-expanded", open ? "true" : "false");
    // Only one panel open at a time — close siblings.
    for (const [oBtn, oPanel] of others) {
      if (open && oPanel && !oPanel.hidden) {
        oPanel.hidden = true;
        if (oBtn) oBtn.setAttribute("aria-expanded", "false");
      }
    }
  }
  if (infoBtn && infoPanel) {
    infoBtn.addEventListener("click", () =>
      togglePanel(infoBtn, infoPanel, [[noteBtn, notePanel], [ssBtn, ssPanel], [scBtn, scPanel]]));
  }
  if (noteBtn && notePanel) {
    noteBtn.addEventListener("click", () =>
      togglePanel(noteBtn, notePanel, [[infoBtn, infoPanel], [ssBtn, ssPanel], [scBtn, scPanel]]));
  }
  if (ssBtn && ssPanel) {
    ssBtn.addEventListener("click", () =>
      togglePanel(ssBtn, ssPanel, [[infoBtn, infoPanel], [noteBtn, notePanel], [scBtn, scPanel]]));
  }
  if (scBtn && scPanel) {
    scBtn.addEventListener("click", () =>
      togglePanel(scBtn, scPanel, [[infoBtn, infoPanel], [noteBtn, notePanel], [ssBtn, ssPanel]]));
  }
  // Assigned by the changelog block below; a no-op until then so the dome
  // button is safe to press regardless of setup order.
  let closeChangelog = () => {};

  // Sky dome. The viewer lives in sky_dome.js and owns its own data fetch,
  // so it costs nothing until the button is pressed.
  const domeBtn = $("#dome-toggle");
  const domeClose = $("#dome-close");
  /* Everything that has to happen before the dome is usable, in one place.
   *
   * Two buttons open it now — the header's, and "Goto Sky Dome" on the
   * slide — and the preamble is not optional for either. It used to live
   * inside the header button's handler, so a second caller would have got a
   * dome with an unclosed changelog behind it and a search that could not
   * find "Andromeda", both only visible by going and looking. */
  async function openDome() {
    if (!window.SkyDome) return false;
    // The changelog is a peer overlay; leaving it open behind the dome
    // means closing the dome drops you back onto a panel you'd forgotten
    // was there. Uses the changelog's own closer so the scrim and the
    // body overflow it manages are unwound exactly as it expects.
    closeChangelog();
    // The dome's search matches on ids and catalogue names; the aliases
    // live here, so hand them over before it can be typed into.
    if (window.SkyDome.setAliases) {
      const m = {};
      for (const o of (CATALOG.objects || [])) {
        const a = [];
        if (o.name && o.name !== o.id) a.push(o.name);
        for (const x of (o.aliases || [])) a.push(x);
        if (a.length) m[o.id] = a;
      }
      /* Families are not catalogue objects, so the loop above cannot see
       * them — but their photographs are on the dome, filed under whichever
       * member named the file. Handing the family title down to every
       * member means typing "Lagoon & Trifid" into the dome finds the
       * frames that ARE the Lagoon & Trifid, instead of finding nothing and
       * reading as though the album had no such thing. */
      for (const f of Object.values(FAMILIES.families || {})) {
        if (!f || !f.title) continue;
        for (const id of (f.members || [])) {
          (m[id] = m[id] || []).push(f.title);
        }
      }
      window.SkyDome.setAliases(m);
    }
    /* And the catalogue itself, for the object circles — the same
     * annotation ASTAP draws on a solved frame: every M / NGC / IC / OCl
     * ringed at its true position and its true angular size.
     *
     * Handed over rather than fetched again by the dome: gallery.js has
     * already merged catalog.json and openngc.json into CATALOG, and a
     * second copy would be a second thing to keep in step.
     *
     * RA is converted to DEGREES here. Both catalogue files store it in
     * HOURS while the dome's own markers are in degrees, and one unit
     * crossing the boundary is one unit to get wrong.
     *
     * Stars, constellations and solar-system bodies are dropped: a star
     * has no meaningful angular size, a constellation's is tens of
     * degrees, and a planet has no fixed position at all. */
    if (window.SkyDome.setCatalog) {
      /* Three things have to be got right here, and a first version got all
       * three wrong in a way only a measurement caught:
       *
       * 1. A MESSIER ENTRY CARRIES NO SIZE. catalog.json's M8 has
       *    size_arcmin null and aliases ["NGC6523"]; the size lives on the
       *    NGC twin (45 arcmin). Defaulting instead drew the Lagoon as a
       *    1-arcmin dot — a 45x error on the album's deepest target.
       * 2. THE TWIN IS THE SAME OBJECT. Drawing both M8 and NGC6523 puts
       *    two rings of different sizes on one nebula.
       * 3. A "REGION" IS NOT AN OBJECT. `MilkyWay` is catalog "Region" with
       *    size 3600 arcmin, so it drew a 60-degree ring over everything at
       *    every zoom.
       *
       * So: resolve each Messier/OCl entry's size through its aliases, mark
       * the twin as claimed, and skip regions and constellations outright.
       * Real large objects stay — the SMC is 300 arcmin and a 5-degree ring
       * round it is correct. */
      const SKIP_TYPE = /^(star|constellation)/i;
      const SKIP_CAT = /^(constellation|region|solar system|field|stars?|variable star)$/i;
      const MAX_RADIUS_DEG = 5;   // backstop; nothing real is 10 degrees wide
      const key = (s) => String(s || "").replace(/\s+/g, "").toUpperCase();

      const ngcById = new Map();
      for (const o of (CATALOG.objects || [])) {
        if (/^(NGC|IC)/i.test(o.id) && Number(o.majAxisArcmin) > 0) {
          ngcById.set(key(o.id), o);
        }
      }

      const claimed = new Set();
      const rows = [];
      const add = (o, maj) => {
        const r = (maj > 0 ? maj / 2 : 1.0) / 60;
        if (r > MAX_RADIUS_DEG) return;
        rows.push({
          id: o.id, n: o.name || o.id, ra: o.ra * 15, dec: o.dec, r,
          t: String(o.type || ""),
          m: (typeof o.magnitude === "number") ? o.magnitude : null,
          sized: maj > 0,
        });
      };

      // Named entries first — they win the name and claim their twin.
      for (const o of (CATALOG.objects || [])) {
        if (o.computeAtRuntime) continue;
        if (typeof o.ra !== "number" || typeof o.dec !== "number") continue;
        if (SKIP_CAT.test(String(o.catalog || ""))) continue;
        if (SKIP_TYPE.test(String(o.type || ""))) continue;
        if (/^(NGC|IC)/i.test(o.id)) continue;        // handled in the pass below
        let maj = Number(o.size_arcmin || o.majAxisArcmin || 0);
        for (const a of (o.aliases || [])) {
          const twin = ngcById.get(key(a));
          if (!twin) continue;
          claimed.add(key(twin.id));
          if (!(maj > 0)) maj = Number(twin.majAxisArcmin || 0);
        }
        add(o, maj);
      }
      // Then every NGC/IC that no named entry already stands for.
      for (const o of (CATALOG.objects || [])) {
        if (!/^(NGC|IC)/i.test(o.id)) continue;
        if (claimed.has(key(o.id))) continue;
        if (typeof o.ra !== "number" || typeof o.dec !== "number") continue;
        if (SKIP_TYPE.test(String(o.type || ""))) continue;
        add(o, Number(o.size_arcmin || o.majAxisArcmin || 0));
      }
      window.SkyDome.setCatalog(rows);
    }
    await window.SkyDome.open();
    if (domeBtn) {
      domeBtn.setAttribute("aria-expanded",
                           window.SkyDome.isOpen() ? "true" : "false");
    }
    return window.SkyDome.isOpen();
  }
  if (domeBtn && window.SkyDome) {
    domeBtn.addEventListener("click", () => { openDome(); });
  }
  /* "Goto Sky Dome" — open the dome and fly to THIS photograph.
   *
   * The path is resolved rather than passed straight through, because the
   * map holds stacks only: the conditioned half of every pair has no
   * footprint on it, and that is the half most slides are showing. So ask
   * for this frame, then the raw it was made from, then anything else of
   * the same target, and only then fall back to the target's id.
   *
   * Flies rather than jumps. Where a photograph sits is the question being
   * asked, and an answer that cuts straight to a filled frame shows you the
   * destination without ever showing you the journey — which is the part
   * that says where on the sky it is. */
  const slideDomeBtn = $("#slide-dome-btn");
  if (slideDomeBtn && window.SkyDome) {
    slideDomeBtn.addEventListener("click", async () => {
      const item = currentItem();
      if (!item) return;
      if (!(await openDome())) return;
      for (const p of domePathsFor(item)) {
        if (window.SkyDome.goToPath && window.SkyDome.goToPath(p)) return;
      }
      if (window.SkyDome.goTo) window.SkyDome.goTo(item.objId);
    });
  }
  if (domeClose && window.SkyDome) {
    domeClose.addEventListener("click", () => {
      window.SkyDome.close();
      if (domeBtn) domeBtn.setAttribute("aria-expanded", "false");
    });
  }
  // Bridge for the dome: clicking a footprint opens that photo in the
  // album below. Kept here rather than in sky_dome.js because the slide
  // index and paintSlide() are this file's business.
  window.openPhotoByPath = (path) => {
    // Find the target, and the mode within it that actually holds this
    // photograph — a footprint clicked on the dome is one specific frame,
    // and landing on the target while showing a different frame of it
    // would quietly answer a question the viewer did not ask.
    let found = null;
    for (const subj of state.subjects) {
      for (const m of MODE_IDS) {
        const list = subj.modes[m] || [];
        const k = list.findIndex(it => it.path === path
          || (it.pair && it.pair.condPath === path)
          || (it.pair && it.pair.rawPath === path));
        if (k >= 0 && !found) found = { subj, mode: m, k };
      }
    }
    if (!found) return false;
    // Deep link into a photograph. It may sit outside the current view —
    // someone follows a link while a search is active — so clear the query
    // and rebuild before resolving, rather than failing to find it.
    let at = navList().indexOf(found.subj);
    if (at < 0) {
      const box = $("#search");
      if (box) box.value = "";
      for (const k of Object.keys(GRID_FILTERS)) {
        GRID_FILTERS[k] = (typeof GRID_FILTERS[k] === "boolean") ? false : "";
      }
      renderGrid();
      at = navList().indexOf(found.subj);
    }
    showSubject(at >= 0 ? at : 0, found.mode);
    state.frame[found.mode] = found.k;
    paintSlide();
    if (domeBtn) domeBtn.setAttribute("aria-expanded", "false");
    const target = $("#slideshow");
    if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
    return true;
  };

  wireSearch();
  wireFilters();

  const starBtn = $("#slide-star");
  if (starBtn) starBtn.addEventListener("click", () => {
    const subj = currentSubject();
    if (!subj) return;
    toggleStar(subj.objId);
    renderStarButton();
    // A card that just left the starred filter must leave the grid with it.
    if (GRID_FILTERS.starred) renderGrid();
  });

  const playBtn = $("#slide-play");
  if (playBtn) playBtn.addEventListener("click", slideshowToggle);
  $("#lang-toggle").addEventListener("click", () => {
    LANG = (LANG === "en") ? "ja" : "en";
    lsSet("astrogallery.lang", LANG);
    applyLanguage();
  });
  // Changelog panel: slide-in dropdown with scrim + click-outside + Esc.
  const clogBtn = $("#changelog-toggle");
  const clogPanel = $("#changelog-panel");
  if (clogBtn && clogPanel) {
    let scrim = document.querySelector(".changelog-scrim");
    if (!scrim) {
      scrim = document.createElement("div");
      scrim.className = "changelog-scrim";
      document.body.appendChild(scrim);
    }
    const setOpen = (open) => {
      clogPanel.hidden = !open;
      clogBtn.setAttribute("aria-expanded", open ? "true" : "false");
      scrim.classList.toggle("open", open);
      document.body.style.overflow = open ? "hidden" : "";
    };
    closeChangelog = () => { if (!clogPanel.hidden) setOpen(false); };
    clogBtn.addEventListener("click", () => setOpen(clogPanel.hidden));
    scrim.addEventListener("click", () => setOpen(false));
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !clogPanel.hidden) setOpen(false);
    });
  }
  window.addEventListener("keydown", (e) => {
    // Yield to anything that already handled the key. The compare slider's
    // own arrow handler calls preventDefault(), but this one ran anyway and
    // changed target underneath it — nudging the divider walked the album.
    // TEXTAREA and contenteditable are here for the same reason INPUT is:
    // typing is not navigation.
    if (e.defaultPrevented) return;
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" ||
              t.isContentEditable)) return;
    // The blow-up is the innermost thing Escape can close, so it answers
    // first and stops the key travelling on to anything else.
    if (e.key === "Escape" && blowupOpen()) {
      e.preventDefault();
      closeBlowup();
      return;
    }
    if (e.key === "ArrowLeft")  goSlide(-1);
    if (e.key === "ArrowRight") goSlide( 1);
    if (e.key === " " || e.code === "Space") {
      // Space scrolls by default, which is the opposite of what someone
      // starting a slideshow wants.
      e.preventDefault();
      slideshowToggle();
    }
  });
  window.addEventListener("resize", () => { sizeStage(); if (state.items[state.index]) drawAnnotations(state.items[state.index]); });

  // Hero scroll fade: fully opaque at scrollY 0, fully transparent by
  // ~70% of viewport height. Requesting a frame per scroll event keeps
  // the effect smooth without piling up work.
  const hero = document.getElementById("hero");
  if (hero) {
    let ticking = false;
    const applyFade = () => {
      ticking = false;
      const y = window.scrollY;
      const fadeEnd = window.innerHeight * 0.7;
      const t = Math.max(0, Math.min(1, y / fadeEnd));
      hero.style.opacity = String(1 - t);
      // Once invisible, drop out of the accessibility tree entirely.
      hero.style.pointerEvents = t >= 1 ? "none" : "auto";
    };
    window.addEventListener("scroll", () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(applyFade);
    }, { passive: true });
    applyFade();
  }

  // Last, once the grid exists and the rotation is running: let the page
  // hand its memory back when the tab is backgrounded or simply left alone.
  initIdleSleep();
}

/* ── Hold a picture to fill the screen ───────────────────────────────
 * Any image in the gallery — a grid tile, a strip thumbnail, either side
 * of a compare slider, a showcase step — opens full screen when it is
 * held. Thumbnails already carry the full-size URL in `data-full` for the
 * onerror fallback, so holding a card shows the real photograph rather
 * than an enlarged thumbnail.
 *
 * A HOLD, not a click: 500 ms with the pointer still. Any movement past
 * FS_MOVE_TOL cancels it, so dragging the compare handle or the showcase
 * scrubber never trips it, and the click that follows a hold is swallowed
 * so the tile does not open behind the viewer.
 */
const FS_HOLD_MS = 500;
const FS_MOVE_TOL = 12;     // px; a hold is allowed to wobble this much
let fsTimer = null, fsOrigin = null, fsFired = false, fsEl = null;

function fsSource(img) {
  return (img.dataset && img.dataset.full) || img.currentSrc || img.src || "";
}

function fsViewer() {
  if (fsEl) return fsEl;
  fsEl = document.createElement("div");
  fsEl.id = "fs-view";
  fsEl.hidden = true;
  fsEl.innerHTML = '<img alt="">'
    + '<button type="button" class="fs-close" aria-label="Close full screen">'
    + "✕</button>";
  fsEl.addEventListener("click", fsClose);
  document.body.appendChild(fsEl);
  return fsEl;
}

function fsOpen(img) {
  const src = fsSource(img);
  if (!src) return;
  const v = fsViewer();
  const shown = v.querySelector("img");
  shown.src = src;
  shown.alt = img.alt || "";
  v.hidden = false;
  document.documentElement.classList.add("fs-open");
  // The Fullscreen API is the point of this, but Safari on iPhone offers it
  // for nothing but video, and a refused promise must not break the viewer:
  // the overlay already covers the window by itself.
  if (v.requestFullscreen) {
    const p = v.requestFullscreen();
    if (p && p.catch) p.catch(() => {});
  }
}

function fsClose() {
  if (!fsEl || fsEl.hidden) return;
  fsEl.hidden = true;
  document.documentElement.classList.remove("fs-open");
  const shown = fsEl.querySelector("img");
  if (shown) shown.src = NAP_PIXEL;        // hand the bitmap back
  if (document.fullscreenElement && document.exitFullscreen) {
    const p = document.exitFullscreen();
    if (p && p.catch) p.catch(() => {});
  }
}

function fsCancelHold() {
  if (fsTimer) clearTimeout(fsTimer);
  fsTimer = null;
  fsOrigin = null;
}

function fsInit() {
  document.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const el = e.target;
    if (!el || !el.closest || el.closest("#fs-view")) return;
    const img = el.closest("img");
    if (!img) return;
    fsFired = false;
    fsOrigin = { x: e.clientX, y: e.clientY };
    if (fsTimer) clearTimeout(fsTimer);
    fsTimer = setTimeout(() => {
      fsTimer = null;
      fsFired = true;
      fsOpen(img);
    }, FS_HOLD_MS);
  }, { passive: true });

  document.addEventListener("pointermove", (e) => {
    if (!fsTimer || !fsOrigin) return;
    if (Math.hypot(e.clientX - fsOrigin.x, e.clientY - fsOrigin.y) > FS_MOVE_TOL) {
      fsCancelHold();
    }
  }, { passive: true });

  for (const ev of ["pointerup", "pointercancel", "pointerleave"]) {
    document.addEventListener(ev, fsCancelHold, { passive: true });
  }
  window.addEventListener("scroll", fsCancelHold, { passive: true });

  // The click a hold leaves behind belongs to the hold, not to the tile.
  document.addEventListener("click", (e) => {
    if (!fsFired) return;
    fsFired = false;
    e.stopPropagation();
    e.preventDefault();
  }, true);

  // Holding a picture should open this, not the browser's own image menu —
  // but only while a hold is actually running, so an ordinary right-click
  // still offers "save image".
  document.addEventListener("contextmenu", (e) => {
    if ((fsTimer || fsFired) && e.target && e.target.closest
        && e.target.closest("img")) {
      e.preventDefault();
    }
  });

  // Escape, or the browser's own exit, closes the viewer with it.
  document.addEventListener("fullscreenchange", () => {
    if (!document.fullscreenElement) fsClose();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") fsClose();
  });
}

document.addEventListener("DOMContentLoaded", () => { main(); fsInit(); });
