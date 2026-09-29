---
name: x402-pay
description: 调用受 x402 协议保护的付费 HTTP 服务：查询报价、用本地 EVM 钱包签名付款（USDC）并取回结果。当你需要调用返回 402 Payment Required 的 API，或其他 Skill（如 app-market）要求通过 x402 调用某个 endpoint 时使用。
---

# x402 Pay

用本地钱包为 x402 服务付款。所有操作通过 `scripts/pay.mjs` 完成（路径相对于本 Skill 目录），需要 Node.js 18 或更高版本，无需安装依赖。

## 配置

由用户自己配置，**不要替用户生成、读取、写入或打印私钥**。每项配置按“环境变量 → 配置文件”的顺序读取：

| 环境变量 | 配置文件字段 | 说明 |
|---|---|---|
| `X402_PRIVATE_KEY` | `private_key` | EVM 私钥（0x 开头）。建议使用只存少量 USDC 的专用钱包 |
| `X402_MAX_PER_PAYMENT` | `max_per_payment` | 单笔付款上限（美元），默认 `1`。脚本拒绝任何超过它的付款 |

配置文件路径是 `~/.config/x402-pay/config.json`（设置了 `XDG_CONFIG_HOME` 时为 `$XDG_CONFIG_HOME/x402-pay/config.json`）。

运行 `node scripts/pay.mjs config` 可以查看当前生效的配置：钱包地址、私钥和上限分别来自哪里（不会显示私钥）。

找不到私钥时，把脚本给出的提示转告用户，请用户自己配置，不要尝试其他付款方式。如果用户说已经设置了环境变量但脚本读不到，多半是因为环境变量只对设置之后启动的进程生效，建议用户改用配置文件。

## 使用流程

### 1. 查询报价（不付款）

```bash
node scripts/pay.mjs quote --url <url> [请求参数]
```

- 返回 `payment_required: true` 时，`options` 列出服务接受的付款方式：网络、金额、币种、收款地址。
- 返回 `payment_required: false` 时，说明服务免费，响应内容就在 `body` 里，不需要再付款。注意这意味着请求已经被执行了一次。

### 2. 告知用户并确认

付款前告诉用户：调用哪个服务、金额和币种、在哪个网络付款。得到确认后再继续。如果用户已经明确授权过这类付款，可以跳过这一步。

### 3. 付款并调用

```bash
node scripts/pay.mjs pay --url <url> --max-amount <金额> --network <网络> [请求参数]
```

- `--max-amount`：本次愿意支付的最高金额（美元）。**必须填报价里的金额**，或者调用方给出的预期价格（例如 app-market manifest 中的 `price`）。服务要价高于它时，脚本会拒绝付款、不签名。
- `--network`：付款网络，默认 `base`。可以用 `base`、`base-sepolia` 或 CAIP-2 格式（如 `eip155:8453`）。脚本只会在这个网络上付款。

### 请求参数

| 参数 | 说明 |
|---|---|
| `--method <GET\|POST>` | 默认：有请求体时用 POST，否则用 GET |
| `--body '<json>'` | JSON 请求体 |
| `--body-file <path>` | 从文件读取 JSON 请求体 |
| `--file <field>=<path>` | 把本地文件转成 data URI（`data:image/jpeg;base64,...`），写入请求体的 `field` 字段，可以重复使用 |

示例：用本地照片调用修图服务

```bash
node scripts/pay.mjs pay --url https://api.example.com/v1/retouch \
  --max-amount 0.05 --network base \
  --body '{"style":"natural"}' --file image=./portrait.jpg
```

### 4. 读取结果

输出是 JSON：

| 字段 | 说明 |
|---|---|
| `ok` | 服务是否返回成功 |
| `settled` | 付款是否已在链上结算 |
| `payment` | 实际选中的付款方式（网络、金额、收款地址） |
| `rejected_reason` | 付款被拒绝的原因，例如 `invalid_exact_evm_insufficient_balance` 表示余额不足 |
| `settlement` | 结算信息，其中 `transaction` 是交易哈希 |
| `body` | 服务返回的内容。二进制内容会保存到临时文件，这里给出 `saved_to` 路径 |

告诉用户结果和实际花费。余额不足时，运行 `node scripts/pay.mjs address` 得到钱包地址，请用户充值。

## 规则

- 不要自行提高 `--max-amount`，也不要修改 `X402_MAX_PER_PAYMENT`。服务要价超出预期时，停止并告诉用户。
- 付款失败时不要反复重试，把错误原因告诉用户。
- 不要读取或输出私钥：不要查看 `X402_PRIVATE_KEY` 的值，也不要打开配置文件。需要确认配置时用 `config` 命令。
