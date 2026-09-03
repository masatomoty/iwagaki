import { defineConfig } from 'vitepress'

// 舞鶴市 高潮浸水シミュレーション — プロジェクト報告。
// 内部の作業ノートは docs/*.md のまま。ここは初見の自治体職員でも
// 「課題 → viewer を触る → 表示の解釈 → 分析結果 → 提言 → 限界」の順で
// 読めるように組んだ報告書。数字は docs/results.md と一致させている。
export default defineConfig({
  lang: 'ja',
  title: '舞鶴市 高潮浸水シミュレーション',
  description:
    'PLATEAU 5m 地形と実測 0.5m 地形で高潮の浸水判定がどこで変わるか。プロジェクト報告。',
  lastUpdated: true,
  cleanUrls: true,
  // 付録 F の分析手法で数式を使う（markdown-it-mathjax3）
  markdown: { math: true },
  // viewer と同一オリジンのサブパスに載せる: iwagaki-viewer.tonbo.workers.dev/report/
  // ビルド成果は web/deploy/deploy.sh が web/dist/report/ にコピーして
  // Workers Assets からそのまま配信する（Worker 側のコード変更は不要）。
  base: '/report/',

  themeConfig: {
    outline: [2, 3],
    docFooter: { prev: '前へ', next: '次へ' },
    lastUpdatedText: '最終更新',

    search: {
      provider: 'local',
      options: {
        translations: {
          button: {
            buttonText: '検索',
            buttonAriaLabel: '検索',
          },
          modal: {
            displayDetails: '詳細を表示',
            resetButtonTitle: '検索条件をリセット',
            backButtonTitle: '検索を閉じる',
            noResultsText: '該当する結果がありません',
            footer: {
              selectText: '選択',
              selectKeyAriaLabel: 'enter',
              navigateText: '移動',
              navigateUpKeyAriaLabel: '上矢印',
              navigateDownKeyAriaLabel: '下矢印',
              closeText: '閉じる',
              closeKeyAriaLabel: 'esc',
            },
          },
        },
      },
    },

    nav: [
      { text: '背景と目的', link: '/' },
      { text: '分析結果', link: '/pages/results' },
      { text: '考察と提言', link: '/pages/discussion' },
      { text: 'viewer を開く', link: 'https://iwagaki-viewer.tonbo.workers.dev' },
    ],

    sidebar: [
      {
        text: '1. 背景と目的',
        link: '/',
      },
      {
        text: '2. viewer の操作',
        link: '/pages/viewer',
      },
      {
        text: '3. 表示の解釈',
        link: '/pages/interpretation',
      },
      {
        text: '4. 分析結果',
        link: '/pages/results',
      },
      {
        text: '5. 考察と提言',
        link: '/pages/discussion',
      },
      {
        text: '6. 前提と限界',
        link: '/pages/limits',
      },
      {
        text: '付録',
        collapsed: false,
        items: [
          { text: 'A. 元の課題との対応', link: '/pages/appendix-correspondence' },
          { text: 'B. 数値データ表', link: '/pages/tables' },
          { text: 'C. 用語', link: '/pages/glossary' },
          { text: 'D. データ出典', link: '/pages/sources' },
          { text: 'E. 他自治体への展開', link: '/pages/other-cities' },
          { text: 'F. 分析手法', link: '/pages/methods' },
        ],
      },
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/masatomoty/iwagaki' },
    ],
  },
})
