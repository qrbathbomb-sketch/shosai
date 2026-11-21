# 自作スキル集(Claude / ChatGPT 共用)

ここにあるスキルは「Agent Skills」形式(フォルダ + `SKILL.md`)。
Claude も ChatGPT(Codex含む)も同じ形式を読めるので、**1か所で管理して両方で使う**。

```
skills/
  <スキル名>/
    SKILL.md        ← 先頭に name / description を書いた手順書(必須)
    references/     ← 詳しい仕様など(任意)
    assets/         ← テンプレートのpptxなど(任意)
```

## 使い方

### ChatGPT(チャッピー)
1. GitHub の Releases → **skills-latest** から使いたいスキルの zip をダウンロード
   (`main` に入ると自動で作り直される。手元なら `scripts/package-skills.sh` でも作れる)
2. ChatGPT のスキル画面からその zip をアップロード

### Claude.ai / Claude デスクトップ
同じ zip を、設定 → 機能(Capabilities)→ スキル からアップロード。

### Claude Code
```
/plugin marketplace add qrbathbomb-sketch/shosai
/plugin install my-skills@qrbathbomb-skills
```
スキルを追加・更新したら `/plugin marketplace update qrbathbomb-skills`。

### Codex(ChatGPTのコーディング版)
`skills/<スキル名>` フォルダを `~/.codex/skills/` にコピー。

## スキルを追加するとき

1. `skills/<スキル名>/` に置く(ChatGPT からダウンロードしたスキルもここに入れる)
2. `.claude-plugin/marketplace.json` の `skills` 配列にパスを1行追加
3. 両方で動くように書くコツ:
   - frontmatter は `name` と `description` だけにする(片方にしかない項目は使わない)
   - 片方専用の道具名は並べて書く
     例: 「PowerPoint スキル(Claude: `pptx` / ChatGPT: Presentations)」
   - ファイルは `references/` `assets/` からの相対パスで参照する

## 収録スキル

| スキル | 内容 |
| --- | --- |
| build-two-event-case-study-slides | 1枚に2イベントを並べる実績スライド(pptx)を参照デッキの体裁どおりに作る |
