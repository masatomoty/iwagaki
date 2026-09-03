import { defineConfig } from 'vitepress'

// 舞鶴市 高潮シミュレーション — 結果と示唆のレポート。
// 内部の作業ノートは docs/*.md のまま。ここは市に返す報告用に組み直したもの。
export default defineConfig({
  lang: 'ja',
  title: '舞鶴市 高潮シミュレーション',
  description:
    'PLATEAU 5m 地形と実測 0.5m 地形で高潮の浸水判定がどこで変わるか。結果と示唆。',
  lastUpdated: true,
  cleanUrls: true,
  // viewer と同一オリジンのサブパスに載せる: iwagaki-viewer.tonbo.workers.dev/report/
  // ビルド成果は web/deploy/deploy.sh が web/dist/report/ にコピーして
  // Workers Assets からそのまま配信する（Worker 側のコード変更は不要）。
  base: '/report/',

  themeConfig: {
    outline: [2, 3],
    docFooter: { prev: '前へ', next: '次へ' },
    lastUpdatedText: '最終更新',

    nav: [
      { text: '概要', link: '/' },
      { text: '結果', link: '/pages/results-spatial' },
      { text: '示唆', link: '/pages/implications' },
      { text: 'viewer', link: 'https://iwagaki-viewer.tonbo.workers.dev' },
    ],

    sidebar: [
      {
        text: 'はじめに',
        items: [
          { text: '概要（お題との対応）', link: '/' },
          { text: '結論', link: '/pages/summary' },
        ],
      },
      {
        text: '結果',
        items: [
          { text: '① 場所が変わる（面積ではなく）', link: '/pages/results-spatial' },
          { text: '② 主因はデータソース', link: '/pages/results-source' },
          { text: '③ 点群の位置づけ', link: '/pages/results-pointcloud' },
          { text: '④ 海面上昇でどこまで広がるか', link: '/pages/results-sealevel' },
          { text: '⑤ 実測との突き合わせ', link: '/pages/results-validation' },
        ],
      },
      {
        text: '示唆',
        items: [{ text: '市への示唆 A / B / C', link: '/pages/implications' }],
      },
      {
        text: '手法と限界',
        items: [
          { text: 'モデルと前提', link: '/pages/method' },
          { text: '既知の限界', link: '/pages/limits' },
        ],
      },
      {
        text: '付録',
        items: [
          { text: 'viewer の使い方', link: '/pages/viewer' },
          { text: '数表', link: '/pages/tables' },
          { text: 'お題の外で足したもの', link: '/pages/extras' },
        ],
      },
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/masatomoty/iwagaki' },
    ],
  },
})
