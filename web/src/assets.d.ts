// `?url` 付きの import を型として通す。Vite が「そのアセットの URL 文字列」に置き換える
// （中身はバンドルに入らず、内容ハッシュ付きで dist/assets に出る）。
//
// tsconfig の `types: []` で `vite/client` を読んでいないので、ここで宣言する。
// 型パッケージを丸ごと入れると DOM 以外のグローバルまで持ち込むことになる。
declare module '*?url' {
  const url: string
  export default url
}
