# x402-pay

一个通用的 Agent Skill：让 Agent 用本地 EVM 钱包为 [x402](https://www.x402.org/) 协议保护的 HTTP 服务付款（USDC），并取回结果。

适用于 Claude Code、Codex、Cursor、Gemini CLI、GitHub Copilot、OpenCode 等支持 Agent Skill 的 Agent。它不依赖任何特定的市场或服务，可以单独使用；也可以配合 [App Market for Agent](https://github.com/shaojunda/app-market-for-agent) 使用，作为调用和付款的一环。

## 功能

- **查询报价**：不付款，先查看服务要价、网络和收款地址
- **付款调用**：自动完成 x402 的“402 → 签名 → 重试”流程
- **多重限额**：
  - 每次调用必须用 `--max-amount` 声明愿意支付的最高金额，服务要价更高时拒绝签名
  - 环境变量 `X402_MAX_PER_PAYMENT` 设定单笔硬上限，`--max-amount` 不能超过它
  - `--network` 限定付款网络，只在这一个网络上签名
- **免费请求**：`request` 调用上传、查询、下载等免费接口，永远不会付款
- **本地文件**：`--file image=./a.jpg` 转成 data URI 写入 JSON 请求体；`--form file=@./a.jpg` 以 multipart 上传文件内容
- **自定义请求头**：`--header 'Idempotency-Key: …'`、`--header 'Authorization: Bearer …'`
- **保存结果**：`--output ./result.jpg` 把图片等二进制响应保存到指定文件
- **零依赖**：Skill 里的脚本已打包成单个文件，安装后不需要 `npm install`

基于官方客户端库 `@x402/fetch`（x402 协议 v2）实现。

## 安装

```bash
npx skills add shaojunda/x402-pay -g -y -a <agent>
```

`<agent>` 换成 `claude-code`、`codex`、`cursor`、`gemini-cli`、`github-copilot`、`opencode` 等。

也可以直接把 `skills/x402-pay/` 目录复制到你的 Agent 的 Skill 目录。

需要 Node.js 18 或更高版本。

## 配置

两种方式任选，环境变量优先。

**配置文件（推荐）**：`~/.config/x402-pay/config.json`

```bash
mkdir -p ~/.config/x402-pay
cat > ~/.config/x402-pay/config.json <<'EOF'
{
  "private_key": "0x...",
  "max_per_payment": "1"
}
EOF
chmod 600 ~/.config/x402-pay/config.json
```

每次调用都会重新读取，所以**已经在运行的 Agent 也能立即用上**。文件权限过宽时，脚本会提示改成 `600`。

**环境变量**：

```bash
export X402_PRIVATE_KEY=0x...       # EVM 私钥
export X402_MAX_PER_PAYMENT=1       # 单笔上限（美元），默认 1
```

注意：环境变量只对设置之后、从同一个终端启动的进程生效。在其他终端或者已经运行的 Agent 里读不到，这种情况请改用配置文件。

运行 `node skills/x402-pay/scripts/pay.mjs config` 可以查看当前生效的配置和它们的来源（不会显示私钥）。

**请使用专用的小额钱包**，只存放少量 USDC。Agent 能执行脚本，理论上也能读到环境变量和配置文件，所以限额只能防止 Agent 误操作，无法防御恶意行为；真正的安全边界是钱包里的余额。

## 使用示例

```bash
S=skills/x402-pay/scripts/pay.mjs

node $S config                                           # 查看生效的配置和钱包地址
node $S quote --url https://x402.org/protected           # 查看报价
node $S pay --url https://x402.org/protected \
  --network base-sepolia --max-amount 0.01               # 付款调用（测试网）
```

`https://x402.org/protected` 是 x402 官方的测试 endpoint，在 Base Sepolia 测试网上收 0.01 测试 USDC。可以用它验证配置是否正确。

详细用法见 [SKILL.md](skills/x402-pay/SKILL.md)。

想了解付款的底层原理（怎么签名、调用哪个合约方法、卖方如何校验、gas 由谁支付、facilitator 能否作恶、卖方何时返回内容），见 [付款流程详解](docs/payment-flow.md)。

## 更新

用 `npx skills add` 安装的：

```bash
npx skills update x402-pay -g -y     # 用户级安装；项目级安装去掉 -g，在项目目录下运行
```

`skills` CLI 会对比 GitHub 上 Skill 目录的版本，有变化才更新；不写 `x402-pay` 则检查所有已安装的 Skill。

手动复制安装的：重新复制 `skills/x402-pay/` 目录覆盖旧版本。

更新后，脚本的改动在下一次调用时立即生效；`SKILL.md` 的改动（如新的使用说明）建议新开一个 Agent 会话，因为部分 Agent 只在会话开始时加载 Skill 说明。配置文件和环境变量不受更新影响。

## 开发

```bash
npm install
npm run build    # 把 src/pay.mjs 打包成 skills/x402-pay/scripts/pay.mjs
```

打包产物需要一起提交，这样通过 git 安装 Skill 时可以直接使用。
