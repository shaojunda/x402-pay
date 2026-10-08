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

调用**已知免费**的接口（如多步流程中的上传、查询、下载）时，用 `request` 代替 `quote`，用法相同，同样永远不会付款：

```bash
node scripts/pay.mjs request --url <url> [请求参数]
```

如果免费接口意外返回 402，`request` 只报告报价，不会付款；这时停下来告诉用户。

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
| `--header 'Name: value'` | 额外的请求头，可以重复使用，如 `Idempotency-Key`、`Authorization: Bearer <令牌>` |
| `--body '<json>'` | JSON 请求体 |
| `--body-file <path>` | 从文件读取 JSON 请求体 |
| `--file <field>=<path>` | 把本地文件转成 data URI（`data:image/jpeg;base64,...`），写入 JSON 请求体的 `field` 字段，可以重复使用 |
| `--form <field>=<value>` | 以 `multipart/form-data` 发送表单字段，可以重复使用；`<field>=@<path>` 表示上传文件内容。不能与 `--body`、`--body-file`、`--file` 同时使用 |
| `--output <path>` | 请求成功时把响应体原样保存到这个文件，适合下载图片等二进制结果 |

接口要求 JSON 还是 multipart，以服务说明为准（如 app-market manifest 中的 `endpoint.content_type`）：要求 multipart 上传文件时用 `--form file=@<path>`，不要转成 base64。

示例：用本地照片调用修图服务

```bash
node scripts/pay.mjs pay --url https://api.example.com/v1/retouch \
  --max-amount 0.05 --network base \
  --body '{"style":"natural"}' --file image=./portrait.jpg
```

示例：多步流程（免费上传 → 付费创建任务 → 免费下载结果）

```bash
node scripts/pay.mjs request --url https://api.example.com/upload --form file=@./photo.jpg
node scripts/pay.mjs pay --url https://api.example.com/tasks --max-amount 0.001 --network eip155:84532 \
  --header 'Idempotency-Key: <随机字符串>' --body '{"uploadId":"..."}'
node scripts/pay.mjs request --url https://api.example.com/result --body '{"taskId":"..."}' \
  --header 'Authorization: Bearer <令牌>' --output ./restored.jpg
```

重试付费请求时，复用同一个 `Idempotency-Key`（如果服务要求），避免重复扣费。

### 4. 读取结果

输出是 JSON：

| 字段 | 说明 |
|---|---|
| `ok` | 服务是否返回成功 |
| `settled` | 付款是否已在链上结算 |
| `payment` | 实际选中的付款方式（网络、金额、收款地址） |
| `rejected_reason` | 付款被拒绝的原因，例如 `invalid_exact_evm_insufficient_balance` 表示余额不足 |
| `settlement` | 结算信息，其中 `transaction` 是交易哈希 |
| `body` | 服务返回的内容。指定了 `--output` 时保存到该文件；未指定时二进制内容保存到临时文件。两种情况都给出 `saved_to` 路径 |

告诉用户结果和实际花费。注意 HTTP 200 不一定代表业务成功：响应体表示失败（如 `"success": false`）时，按失败处理。余额不足时，运行 `node scripts/pay.mjs address` 得到钱包地址，请用户充值。

## 规则

- 不要自行提高 `--max-amount`，也不要修改 `X402_MAX_PER_PAYMENT`。服务要价超出预期时，停止并告诉用户。
- 付款失败时不要反复重试，把错误原因告诉用户。
- 不要读取或输出私钥：不要查看 `X402_PRIVATE_KEY` 的值，也不要打开配置文件。需要确认配置时用 `config` 命令。
