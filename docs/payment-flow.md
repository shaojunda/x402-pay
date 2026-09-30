# x402-pay 付款流程详解

本文说明 x402-pay 如何配合 [x402 协议](https://www.x402.org/) 完成一次付款：买方怎么签名、调用了哪个合约方法、卖方校验了什么、gas 由谁支付、为什么不必担心 facilitator 作恶，以及卖方是在什么时刻返回内容的。

内容依据官方库 `@x402/fetch`、`@x402/core`、`@x402/evm`、`@x402/hono`（2.27.0）的源码，以及在 Base Sepolia 上的真实交易。只讨论 x402-pay 使用的场景：`exact` 付款方式 + USDC（EIP-3009），网络为 Base / Base Sepolia。

## 目录

1. [参与方](#1-参与方)
2. [完整流程](#2-完整流程)
3. [买方：签名](#3-买方签名)
4. [链上：调用的合约方法](#4-链上调用的合约方法)
5. [卖方：校验与结算](#5-卖方校验与结算)
6. [卖方什么时候返回内容](#6-卖方什么时候返回内容)
7. [gas 由谁支付](#7-gas-由谁支付)
8. [为什么不必担心 facilitator 作恶](#8-为什么不必担心-facilitator-作恶)
9. [x402-pay 额外做的保护](#9-x402-pay-额外做的保护)
10. [真实交易示例](#10-真实交易示例)

---

## 1. 参与方

| 参与方 | 在本项目中是 | 职责 |
|---|---|---|
| **买方** | Agent + x402-pay（内部使用 `@x402/fetch`、`@x402/evm`） | 持有私钥；签署付款授权；**不发链上交易** |
| **卖方** | 付费 API + x402 中间件（如 `@x402/hono`） | 声明价格和收款地址；请 facilitator 校验和结算；结算成功后返回内容 |
| **Facilitator** | 如 `https://x402.org/facilitator` | 校验授权；把授权提交上链；**支付 gas** |
| **USDC 合约** | Base 上的 USDC | 最终核对签名并执行转账 |

买方和 facilitator 之间**没有直接通信**，买方只和卖方打交道。

---

## 2. 完整流程

```
 买方 (x402-pay)             卖方 (x402 中间件)              Facilitator                 USDC 合约
      │                            │                              │                           │
      │ ① POST /v1/name（不带付款）│                              │                           │
      │───────────────────────────>│                              │                           │
      │ ② 402 + PAYMENT-REQUIRED   │                              │                           │
      │<───────────────────────────│                              │                           │
      │                            │                              │                           │
 ③ 本地检查（网络、限额）          │                              │                           │
 ④ 离线签名 EIP-3009 授权          │                              │                           │
   （不上链、不花 gas）            │                              │                           │
      │                            │                              │                           │
      │ ⑤ POST /v1/name            │                              │                           │
      │   + PAYMENT-SIGNATURE      │                              │                           │
      │───────────────────────────>│ ⑥ /verify                    │                           │
      │                            │─────────────────────────────>│ 签名、收款人、金额、       │
      │                            │                              │ 有效期；模拟执行 ─────────>│ eth_call（只读）
      │                            │                              │<──────────────────────────│
      │                            │       isValid: true          │                           │
      │                            │<─────────────────────────────│                           │
      │                   ⑦ 执行业务逻辑                          │                           │
      │                    （生成名字，暂不返回）                  │                           │
      │                            │ ⑧ /settle                    │                           │
      │                            │─────────────────────────────>│ ⑨ 发送交易（付 gas）       │
      │                            │                              │──────────────────────────>│
      │                            │                              │   transferWithAuthorization
      │                            │                              │ ⑩ 等待交易回执，           │
      │                            │                              │    核对 Transfer 事件      │
      │                            │                              │<──────────────────────────│
      │                            │  success + 交易哈希           │                           │
      │                            │<─────────────────────────────│                           │
      │ ⑪ 200 + 名字               │                              │                           │
      │   + PAYMENT-RESPONSE       │                              │                           │
      │<───────────────────────────│                              │                           │
```

任何一步失败，买方都拿不到内容：⑥ 校验失败、⑦ 业务出错（返回 4xx/5xx）时，**不会结算**；⑧–⑩ 结算失败时，卖方**扣下内容**，改为返回错误。

---

## 3. 买方：签名

### 3.1 收到的支付要求

第 ② 步，卖方在 `PAYMENT-REQUIRED` 响应头中返回 base64 编码的 JSON（节选）：

```json
{
  "x402Version": 2,
  "accepts": [{
    "scheme": "exact",
    "network": "eip155:84532",
    "amount": "10000",
    "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    "payTo": "0xF36DFB8B4c2080696e30e72F1b0E644115c8da1B",
    "maxTimeoutSeconds": 300,
    "extra": { "name": "USDC", "version": "2" }
  }]
}
```

- `amount` 是 USDC 的最小单位（6 位小数），10000 = 0.01 USDC。
- `asset` 是 USDC 合约地址。
- `extra.name` / `extra.version` 是 USDC 合约的 EIP-712 域信息，签名时要用。

### 3.2 签名前的检查

`@x402/core` 的 `x402Client` 在签名前依次：

1. **筛选付款方式**：只保留买方注册过的网络和方案。x402-pay 只注册 `--network` 指定的那一个网络，其他网络的报价直接被忽略。
2. **限额检查（`spendControls`）**：金额超过 `--max-amount` 就拒绝，**不会签名**。
3. **执行回调**（`onBeforePaymentCreation`）：x402-pay 在这里记录选中的付款方式，用于输出。

### 3.3 签的是什么

签名由 `@x402/evm` 的 `ExactEvmScheme` 完成，使用 **EIP-712 结构化签名**，签署一张 **EIP-3009 `TransferWithAuthorization` 授权**：

```
┌──────────────── EIP-712 Domain（签名绑定的“场合”） ────────────────┐
│ name              = "USDC"          ← 来自 extra.name               │
│ version           = "2"             ← 来自 extra.version            │
│ chainId           = 84532           ← 来自 network eip155:84532     │
│ verifyingContract = 0x036C…CF7e     ← 来自 asset（USDC 合约）        │
└─────────────────────────────────────────────────────────────────────┘
┌──────────────── Message: TransferWithAuthorization ─────────────────┐
│ from        = 买方地址                                               │
│ to          = payTo（卖方收款地址）                                  │
│ value       = amount（10000）                                        │
│ validAfter  = 0                                                      │
│ validBefore = 当前时间 + maxTimeoutSeconds（300 秒）                 │
│ nonce       = 32 字节随机数（crypto.getRandomValues）                 │
└─────────────────────────────────────────────────────────────────────┘
                        │
                        ▼
      viem：signTypedData（用私钥做 ECDSA 签名）→ 65 字节签名 (r, s, v)
```

要点：

- **签名只在本地进行**，不发交易、不需要 ETH、不联网。
- Domain 把签名**绑定到这条链上的这一个 USDC 合约**：换一条链或换一个合约，签名都无效。
- Message 的每个字段都被签名覆盖，任何人改动其中一个字段，签名就对不上。

### 3.4 发送

签名和授权内容组成付款数据，base64 编码后放进请求头 `PAYMENT-SIGNATURE`（x402 v1 叫 `X-PAYMENT`），**原样重发第一次的请求**。

`@x402/fetch` 还有两条保护：

- 请求里已经带有付款头时直接报错（`Payment already attempted`），不会重复签名。
- 第二次请求后，如果库判断付款可以挽回，会用**新的 nonce 重新签一次**、重发一次；旧授权没被使用就自然作废，不会重复扣款。

---

## 4. 链上：调用的合约方法

结算时，facilitator 调用 USDC 合约的 EIP-3009 方法：

```solidity
function transferWithAuthorization(
    address from,
    address to,
    uint256 value,
    uint256 validAfter,
    uint256 validBefore,
    bytes32 nonce,
    uint8 v, bytes32 r, bytes32 s     // 买方的签名
)
// 函数选择器：0xe3ee160e
```

合约执行时自己做最终检查，任何一项不满足整笔交易就回滚：

```
transferWithAuthorization(...)
  ├─ validAfter < block.timestamp < validBefore ？   时间窗口
  ├─ authorizationState[from][nonce] == false ？      这张授权没被用过
  ├─ ecrecover(EIP-712 哈希, v, r, s) == from ？      签名确实来自 from
  ├─ authorizationState[from][nonce] = true           标记为已使用（防重放）
  ├─ _transfer(from, to, value)                       余额不足则回滚
  └─ emit AuthorizationUsed(from, nonce)
     emit Transfer(from, to, value)
```

注意：**调用者（`msg.sender`）是谁无所谓**，合约只认签名。这就是买方不用付 gas、也不必信任提交者的根本原因。

---

## 5. 卖方：校验与结算

### 5.1 中间件的流程

`exact` + EIP-3009 默认使用 `authorization` 付款流程：**先校验，再执行业务，最后结算**。

```
收到请求
   │
   ├─ 没有 PAYMENT-SIGNATURE ──────────────────────> 返回 402 + 支付要求
   │
   ├─ 解析付款数据，匹配本路由要求的付款方式
   │
   ├─ 调用 facilitator /verify
   │     └─ 无效 ──────────────────────────────────> 返回 402（带失败原因）
   │
   ├─ 执行业务 handler
   │     └─ 返回 4xx/5xx ─────────> 取消结算 ──────> 原样返回错误（不扣费）
   │
   ├─ 调用 facilitator /settle（等待链上确认）
   │     └─ 失败 ─────────────────> 扣下内容 ──────> 返回错误
   │
   └─ 成功 ───────> 返回内容 + PAYMENT-RESPONSE（含交易哈希）
```

除默认的 `authorization` 外，库还支持 `upfront`（先结算、再执行业务）。本项目使用默认值。

### 5.2 `/verify` 校验了什么

按 `@x402/evm` facilitator 的执行顺序：

| # | 检查 | 失败原因（`invalidReason`） |
|---|---|---|
| 1 | 付款方式是 `exact` | `invalid_scheme` |
| 2 | 支付要求中有 EIP-712 域信息（`extra.name` / `extra.version`） | 缺少域信息 |
| 3 | 付款数据的网络与支付要求一致 | 网络不匹配 |
| 4 | **签名有效**：普通钱包用 ECDSA 验证；智能合约钱包按 EIP-1271 / EIP-6492 验证（未部署的钱包还要求工厂合约在白名单内） | `invalid_exact_evm_signature` 等 |
| 5 | **收款人**：授权里的 `to` 等于 `payTo` | `invalid_exact_evm_recipient_mismatch` |
| 6 | **未过期**：`validBefore` 至少还有 6 秒 | `…_valid_before` |
| 7 | **已生效**：`validAfter` 不晚于现在 | `…_valid_after` |
| 8 | **金额**：`value` **严格等于** `amount` | `…_authorization_value_mismatch` |
| 9 | `asset` 是有效的代币合约 | — |
| 10 | **模拟执行**：用只读调用（`eth_call`）预演 `transferWithAuthorization`，不会真的转账 | 见下 |

模拟执行失败时，facilitator 会进一步诊断具体原因：

| 诊断 | 失败原因 |
|---|---|
| 代币不支持 EIP-3009 | `…_eip3009_not_supported` |
| nonce 已被使用（重放） | `…_nonce_already_used` |
| 代币名称或版本与域信息不符 | `…_token_name_mismatch` / `…_token_version_mismatch` |
| **余额不足** | `invalid_exact_evm_insufficient_balance` |

用没有余额的钱包测试时，拿到的就是最后这个 `insufficient_balance`：这说明第 1–9 项全部通过，签名是有效的。

### 5.3 `/settle` 做了什么

```
/settle
  ├─ 再次校验（同 /verify）
  ├─ 发送交易：transferWithAuthorization(...)       ← facilitator 付 gas
  ├─ 等待交易回执（有超时）
  │     └─ 超时 ─────────────> success: false, settlement_pending
  ├─ 回执 status != success ─> success: false, transaction_failed
  ├─ 回执中的 Transfer 事件的 from / to / value 与授权一致？
  │     └─ 不一致 ───────────> success: false, transfer_event_mismatch
  └─ success: true, transaction: 交易哈希, payer: 买方地址
```

---

## 6. 卖方什么时候返回内容

**结论：不是拿到签名就返回，而是等交易在链上确认成功之后才返回。**

- 拿到签名后，卖方只会先 `/verify`，然后执行业务逻辑；业务结果**暂时扣在手里**。
- `/settle` 会等到交易被打包、拿到回执、核对了 `Transfer` 事件，才返回成功。
- 中间件收到结算成功后，才把内容连同 `PAYMENT-RESPONSE`（含交易哈希）一起返回；结算失败就**不返回内容**。

所以链上确认是在**请求处理过程中**同步完成的，不是事后由 facilitator 异步保证。代价是每次调用要多等一个区块（Base 出块约 2 秒）。

### 为什么不能“拿到签名就返回”

签名有效不代表钱一定能到账。在 `/verify` 和真正上链之间，买方可以：

```
时刻 T1：买方签授权 A（付给卖方 X），X /verify 通过
时刻 T2：买方签授权 B（付给别人），先一步上链，把余额花光
时刻 T3：X 提交授权 A → 余额不足，交易回滚
```

nonce 只能防止**同一张授权**被重复使用，防不住“两张不同的授权抢同一笔余额”。如果卖方在 T1 就返回内容，就可能白干。等链上确认后再返回，这个风险就消失了。

### 已知的边界情况

如果 facilitator 等待回执**超时**，会返回 `settlement_pending`（按失败处理），卖方扣下内容。但交易可能稍后才上链成功，这时**买方已付款却没拿到内容**。

这种情况很少见（通常是网络拥堵或节点异常）。买方可以用响应中的交易哈希在区块浏览器上核实，再联系卖方。x402 本身不提供退款机制。

---

## 7. gas 由谁支付

**由 facilitator 支付，买方和卖方都不用付。**

- 买方只做离线签名，从不发交易，所以钱包里**只需要 USDC，不需要 ETH**。
- 发送 `transferWithAuthorization` 交易的是 facilitator，gas 从它的钱包扣。
- 卖方也不发交易，服务器上**不需要私钥**，只需要配置收款地址。

真实数据（见[第 10 节](#10-真实交易示例)）：买方钱包的 ETH 余额为 0，发出过的交易数为 0；结算交易由 facilitator 地址发送，消耗 102,820 gas。

facilitator 的成本：测试网用免费的测试 ETH；主网上 Base 的一笔转账通常只要几分之一美分，运营方可能自行承担，也可能向卖方收取服务费，但都不会向买方收取 gas。

**例外**：不支持 EIP-3009 的代币会改用 Permit2 方案，买方需要**事先在链上做一次授权**，那一次要自己付 gas。x402-pay 目前只处理 USDC，不涉及这种情况。

---

## 8. 为什么不必担心 facilitator 作恶

facilitator 手里只有一张**内容被签名锁死**的授权，它能做的事非常有限：

| facilitator 想做的事 | 能否做到 | 原因 |
|---|---|---|
| 改金额、改收款人 | ❌ | 这些字段都在签名里，改了签名就对不上，合约会拒绝 |
| 把授权用在别的链或别的代币上 | ❌ | Domain 绑定了 `chainId` 和 USDC 合约地址 |
| 同一张授权扣两次钱 | ❌ | 合约记录 nonce，用过一次就作废 |
| 攒着授权以后再用 | ❌ | `validBefore` 只有 5 分钟（`maxTimeoutSeconds`），过期作废 |
| 把钱转给自己 | ❌ | 收款人固定为 `payTo` |
| **不提交、拖延提交** | ✅ | 最坏结果是付款失败：买方没花钱，也拿不到内容；授权 5 分钟后自动作废 |
| **对卖方谎报“结算成功”** | ✅ | 受损的是卖方（交付了内容却没收到钱），**不是买方**；卖方可以用交易哈希上链核实，或者自己运行 facilitator |

另外，即使授权被第三方截获并抢先提交，钱也只会按原样转给卖方，买方和卖方都没有损失。

**总结**：对买方来说，facilitator 最多让付款**失败**，不能让买方**多付**或者**付错人**。真正需要买方信任的是**卖方**：卖方收了钱是否交付合格的内容，x402 不负责。

---

## 9. x402-pay 额外做的保护

在官方库的基础上，x402-pay 签名之前还会检查：

| 保护 | 实现 |
|---|---|
| 单次愿付上限 | `--max-amount` 必填，传给 `spendControls.maxAmountPerPayment`；服务要价更高就不签名 |
| 单笔硬上限 | `X402_MAX_PER_PAYMENT` / 配置文件 `max_per_payment`，默认 1 美元；`--max-amount` 不能超过它 |
| 限定网络 | 只在 `--network` 指定的网络上注册签名方案 |
| 先查报价 | `quote` 命令只读取 402 中的报价，不签名 |

这些都是**防误操作**的手段。Agent 能运行脚本，理论上也能改参数或读私钥，所以真正的安全边界是**钱包余额**：请使用只存少量 USDC 的专用钱包。

---

## 10. 真实交易示例

x402-naming-demo 的一次付费调用（Base Sepolia）：[0xc1da…3111](https://sepolia.basescan.org/tx/0xc1dad191d690f7b906b9770a58d67158c6ed9cd3e0af4325f37c1bb3af6a3111)

```
交易发送方（付 gas）：0xd407…f1bf        ← x402.org facilitator
调用的合约：         0x036C…CF7e        ← Base Sepolia USDC
函数选择器：         0xe3ee160e         ← transferWithAuthorization（v, r, s 版本）
参数：
  from        = 0x1Ab4…A680             ← 买方
  to          = 0xF36D…da1B             ← 卖方（payTo）
  value       = 10000                   ← 0.01 USDC
  validAfter  = 0
  validBefore = 2026-09-29 09:04:32 UTC ← 签名时刻 + 300 秒
  nonce       = 0x6cab…753e             ← 随机数
事件：         Transfer(0x1Ab4…A680 → 0xF36D…da1B, 0.01 USDC)
gas：          102,820，由发送方支付
买方状态：     ETH 余额 0，发出交易数 0
```
