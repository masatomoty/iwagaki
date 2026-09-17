// 標高基準（測地成果2011／2024）の表示切替。
//
// 地形（PLATEAU・地上点群・京都府 0.5m DEM）は**測地成果2011 でしか作られていない**
// （提供元の教示、docs/data.md「標高成果の世代」）。解析・判定（h_conn・タイル・
// 建物の浸水深）は常にこの基準の T.P. で行い、**ここは変えない**（変えるとタイル・
// h_conn を全部作り直すことになる）。
//
// 一方、気象庁の潮位（推算潮位表・公表値）はいまは測地成果2024 で出ている。画面の
// 数字を読むたびに頭の中で換算するのは無理があるので、**画面に出す m T.P. の値**
// だけを選んだ基準で変換する（舞鶴市要望、2026-09）。変換は単一のスカラー
// （`vertical.jgd2011_to_jgd2024_shift_m`, 実体は `config.py` の
// `HYOKO_DH_JGD2011_TO_2024`）で足りる — AOI 内でのメッシュ間差は 4 mm 程度で
// 無視できる（docs/data.md）。

export type ElevationDatum = 'jgd2011' | 'jgd2024'

/** 気象庁の公表値がいまこちらなので、viewer の既定はこちらにする（舞鶴市要望）。 */
export const DEFAULT_ELEVATION_DATUM: ElevationDatum = 'jgd2024'

/** 解析の内部値（測地成果2011）を、選んだ基準の表示値に変換する。 */
export function toDisplayTp(internalTpJgd2011: number, datum: ElevationDatum, shiftM: number): number {
  return datum === 'jgd2024' ? internalTpJgd2011 + shiftM : internalTpJgd2011
}

/** 表示値（選んだ基準）を解析の内部値（測地成果2011）に戻す。手入力を受け取るときに使う。 */
export function fromDisplayTp(displayTp: number, datum: ElevationDatum, shiftM: number): number {
  return datum === 'jgd2024' ? displayTp - shiftM : displayTp
}

/** `toDisplayTp` を部分適用したフォーマッタ。描画側は基準・shift を毎回渡さずに済む */
export function displayTpFormatter(datum: ElevationDatum, shiftM: number): (v: number) => number {
  return (v: number) => toDisplayTp(v, datum, shiftM)
}

const LS_KEY = 'iwagaki.elevationDatum'

/** private モード等で `localStorage` が例外を投げても既定値で続行する（`ui/operationSettingsModal.ts` と同じ書き方） */
export function loadElevationDatum(): ElevationDatum {
  try {
    const raw = localStorage.getItem(LS_KEY)
    return raw === 'jgd2011' || raw === 'jgd2024' ? raw : DEFAULT_ELEVATION_DATUM
  } catch { return DEFAULT_ELEVATION_DATUM }
}

export function saveElevationDatum(d: ElevationDatum): void {
  try { localStorage.setItem(LS_KEY, d) } catch { /* private モード */ }
}
