name: 诊断-直播列表
on:
  workflow_dispatch:
permissions:
  contents: read
jobs:
  diag:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
      - name: 跑诊断
        run: node diag-live.mjs
        env:
          POCKET48_TOKEN: ${{ secrets.POCKET48_TOKEN }}
          SCRAPE_PROXY: ${{ secrets.SCRAPE_PROXY }}
