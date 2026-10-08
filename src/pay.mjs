#!/usr/bin/env node
// x402 付费调用脚本：向受 x402 保护的 HTTP endpoint 发请求，按需签名付款，返回结果。
//
// 用法：
//   node pay.mjs config                                查看配置来源、钱包地址和单笔上限（不显示私钥）
//   node pay.mjs address                               查看钱包地址（用于充值）
//   node pay.mjs quote --url <url> [请求参数]            不付款，只查看报价
//   node pay.mjs request --url <url> [请求参数]          调用免费接口（上传、查询、下载等），永远不付款
//   node pay.mjs pay --url <url> --max-amount <金额> [请求参数]
//
// 请求参数：
//   --method <GET|POST>          默认 POST（有请求体时）或 GET
//   --header 'Name: value'       额外的请求头（可重复），如 Idempotency-Key、Authorization
//   --body <json>                JSON 请求体
//   --body-file <path>           从文件读取 JSON 请求体
//   --file <field>=<path>        把本地文件转成 data URI，写入 JSON 请求体的 field 字段（可重复）
//   --form <field>=<value>       multipart/form-data 字段（可重复）；<field>=@<path> 表示上传文件内容
//                                --form 不能与 --body、--body-file、--file 同时使用
//   --output <path>              请求成功时把响应体原样保存到该文件（如下载图片）
//   --network <name>             只允许在这个网络付款：base、base-sepolia 或 CAIP-2（如 eip155:8453），默认 base
//
// 配置（环境变量优先，其次是配置文件 ~/.config/x402-pay/config.json）：
//   X402_PRIVATE_KEY      / private_key       EVM 私钥（0x 开头），只用于 pay、address 和 config
//   X402_MAX_PER_PAYMENT  / max_per_payment   单笔付款硬上限（美元），默认 1；--max-amount 不能超过它
//
// 配置文件适合已经在运行的 Agent：环境变量只对设置之后启动的进程生效，配置文件每次调用都会重新读取。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { wrapFetchWithPayment, x402Client, x402HTTPClient } from "@x402/fetch";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const NETWORK_ALIASES = { base: "eip155:8453", "base-sepolia": "eip155:84532" };

// USDC 合约地址 → 精度，用来把原子单位换算成可读金额
const KNOWN_ASSETS = {
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": { symbol: "USDC", decimals: 6 }, // Base
  "0x036cbd53842c5426634e7929541ec2318f3dcf7e": { symbol: "USDC", decimals: 6 }, // Base Sepolia
};

const MIME_TYPES = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif",
  ".webp": "image/webp", ".pdf": "application/pdf", ".mp3": "audio/mpeg", ".wav": "audio/wav",
  ".txt": "text/plain", ".json": "application/json",
};

function fail(message) {
  process.stderr.write(`错误：${message}\n`);
  process.exit(1);
}

function print(data) {
  process.stdout.write(JSON.stringify(data, null, 2) + "\n");
}

function resolveNetwork(name = "base") {
  const network = NETWORK_ALIASES[name] || name;
  if (!/^eip155:\d+$/.test(network)) fail(`不支持的网络：${name}（目前只支持 EVM 网络）`);
  return network;
}

function formatAmount(req) {
  const known = KNOWN_ASSETS[req.asset?.toLowerCase()];
  if (!known) return { amount_atomic: req.amount, asset: req.asset };
  const value = Number(req.amount) / 10 ** known.decimals;
  return { amount: String(value), asset: known.symbol, asset_address: req.asset };
}

function describeRequirement(req) {
  return { scheme: req.scheme, network: req.network, ...formatAmount(req), pay_to: req.payTo };
}

const CONFIG_FILE = path.join(
  process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
  "x402-pay",
  "config.json",
);

let configCache;

// 读取配置文件；不存在时返回空对象。权限过宽时提醒，但不阻止使用
function loadConfigFile() {
  if (configCache) return configCache;
  if (!fs.existsSync(CONFIG_FILE)) return (configCache = {});
  if (process.platform !== "win32" && fs.statSync(CONFIG_FILE).mode & 0o077) {
    process.stderr.write(`提示：${CONFIG_FILE} 对其他用户可读，建议运行 chmod 600 ${CONFIG_FILE}\n`);
  }
  try {
    configCache = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    fail(`${CONFIG_FILE} 不是合法的 JSON`);
  }
  return configCache;
}

// 按“环境变量 → 配置文件”的顺序取值，并记录来源
function setting(envName, fileKey) {
  if (process.env[envName]) return { value: process.env[envName], source: `环境变量 ${envName}` };
  const value = loadConfigFile()[fileKey];
  if (value !== undefined && value !== "") return { value: String(value), source: `配置文件 ${CONFIG_FILE}` };
  return { value: undefined, source: null };
}

function loadAccount() {
  const { value: key, source } = setting("X402_PRIVATE_KEY", "private_key");
  if (!key) {
    fail(
      `没有找到私钥。请设置环境变量 X402_PRIVATE_KEY，或创建配置文件 ${CONFIG_FILE}，内容为 {"private_key": "0x..."}，并运行 chmod 600 ${CONFIG_FILE}`,
    );
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) fail(`私钥格式不正确（来自${source}），应为 0x 开头的 64 位十六进制`);
  return { account: privateKeyToAccount(key), source };
}

function hardCap() {
  const { value: raw = "1", source } = setting("X402_MAX_PER_PAYMENT", "max_per_payment");
  const cap = Number(raw);
  if (!(cap > 0)) fail(`单笔上限必须是正数，当前为 ${raw}（来自${source}）`);
  return { cap, source: source || "默认值" };
}

function splitPair(spec, sep, flag, format) {
  const i = spec.indexOf(sep);
  if (i <= 0) fail(`${flag} 格式应为 ${format}，收到 ${spec}`);
  return [spec.slice(0, i).trim(), spec.slice(i + 1).trim()];
}

function mimeOf(file) {
  return MIME_TYPES[path.extname(file).toLowerCase()] || "application/octet-stream";
}

// multipart 表单：--form field=value 为普通字段，--form field=@path 上传文件内容
function buildForm(specs) {
  const form = new FormData();
  for (const spec of specs) {
    const [field, value] = splitPair(spec, "=", "--form", "<field>=<value> 或 <field>=@<path>");
    if (value.startsWith("@")) {
      const file = value.slice(1);
      if (!fs.existsSync(file)) fail(`--form 指定的文件不存在：${file}`);
      form.append(field, new Blob([fs.readFileSync(file)], { type: mimeOf(file) }), path.basename(file));
    } else {
      form.append(field, value);
    }
  }
  return form;
}

function buildRequest(values) {
  const hasJson = values.body || values["body-file"] || values.file?.length;
  if (values.body && values["body-file"]) fail("--body 和 --body-file 只能二选一");
  if (values.form?.length && hasJson) fail("--form（multipart）不能和 --body、--body-file、--file 同时使用");

  const headers = {};
  for (const spec of values.header || []) {
    const [name, value] = splitPair(spec, ":", "--header", "'Name: value'");
    headers[name] = value;
  }

  let body;
  if (values.form?.length) {
    body = buildForm(values.form); // Content-Type（含 boundary）由 fetch 自动设置
  } else if (hasJson) {
    let json;
    if (values.body) json = JSON.parse(values.body);
    if (values["body-file"]) json = JSON.parse(fs.readFileSync(values["body-file"], "utf8"));
    for (const spec of values.file || []) {
      const [field, file] = splitPair(spec, "=", "--file", "<field>=<path>");
      json = json || {};
      json[field] = `data:${mimeOf(file)};base64,${fs.readFileSync(file).toString("base64")}`;
    }
    headers["content-type"] = "application/json";
    body = JSON.stringify(json);
  }

  const method = (values.method || (body !== undefined ? "POST" : "GET")).toUpperCase();
  return body === undefined ? { method, headers } : { method, headers, body };
}

// 响应体：指定了 --output 且请求成功时原样保存到该文件；否则 JSON 直接解析、文本原样返回、二进制保存到临时文件
async function readBody(res, output) {
  const type = res.headers.get("content-type") || "";
  if (output && res.ok) {
    const bytes = Buffer.from(await res.arrayBuffer());
    fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
    fs.writeFileSync(output, bytes);
    return { saved_to: path.resolve(output), content_type: type, bytes: bytes.length };
  }
  if (type.includes("json")) {
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  if (type.startsWith("text/") || type === "") return await res.text();
  const ext = Object.entries(MIME_TYPES).find(([, m]) => type.startsWith(m))?.[0] || ".bin";
  const file = path.join(os.tmpdir(), `x402-response-${Date.now()}${ext}`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  return { saved_to: file, content_type: type };
}

function readPaymentRequired(res, bodyText) {
  const header = res.headers.get("payment-required");
  if (header) return decodePaymentRequiredHeader(header);
  // x402 v1 把支付要求放在响应体里
  try {
    const parsed = JSON.parse(bodyText);
    if (Array.isArray(parsed.accepts)) return parsed;
  } catch {}
  return null;
}

async function cmdConfig() {
  const { account, source } = loadAccount();
  const { cap, source: capSource } = hardCap();
  print({
    config_file: CONFIG_FILE,
    config_file_exists: fs.existsSync(CONFIG_FILE),
    address: account.address,
    private_key_source: source,
    max_per_payment: cap,
    max_per_payment_source: capSource,
  });
}

async function cmdAddress() {
  print({ address: loadAccount().account.address });
}

// quote 与 request 都只发一次不带付款的请求，永远不会付款：
//   quote   用于查看收费接口的报价
//   request 用于调用免费接口（上传、查询、下载等）；如果意外收到 402，会报告报价但不付款
async function cmdQuote(values) {
  if (!values.url) fail("缺少 --url");
  const res = await fetch(values.url, buildRequest(values));
  if (res.status !== 402) {
    return print({ status: res.status, ok: res.ok, payment_required: false, body: await readBody(res, values.output) });
  }
  const paymentRequired = readPaymentRequired(res, await res.text());
  if (!paymentRequired) fail("收到 402，但无法解析支付要求");
  print({
    status: 402,
    payment_required: true,
    x402_version: paymentRequired.x402Version,
    options: paymentRequired.accepts.map(describeRequirement),
    note: "该接口需要付款，本命令不会付款；确认价格后用 pay 命令调用",
  });
}

async function cmdPay(values) {
  if (!values.url) fail("缺少 --url");
  if (!values["max-amount"]) fail("缺少 --max-amount（本次愿意支付的最高金额，单位美元）");
  const maxAmount = Number(values["max-amount"]);
  if (!(maxAmount > 0)) fail("--max-amount 必须是正数");
  const { cap, source: capSource } = hardCap();
  if (maxAmount > cap) fail(`--max-amount ${maxAmount} 超过了单笔上限 ${cap}（来自${capSource}）`);

  const network = resolveNetwork(values.network);
  const client = x402Client.fromConfig({
    // 只在指定网络上注册签名方案，其他网络的报价会被忽略
    schemes: [{ network, client: new ExactEvmScheme(loadAccount().account) }],
    spendControls: { maxAmountPerPayment: `$${maxAmount}` },
  });

  let selected;
  client.onBeforePaymentCreation(async ({ selectedRequirements }) => {
    selected = selectedRequirements;
  });

  const fetchWithPayment = wrapFetchWithPayment(fetch, client);
  let res;
  try {
    res = await fetchWithPayment(values.url, buildRequest(values));
  } catch (err) {
    if (err.message.includes("No network/scheme registered")) {
      fail(`付款未完成：服务不接受 ${network} 上的付款。先用 quote 查看它支持的网络，再用 --network 指定`);
    }
    fail(`付款未完成：${err.message}`);
  }

  let settlement = null;
  try {
    settlement = new x402HTTPClient(client).getPaymentSettleResponse((name) => res.headers.get(name));
  } catch {}

  // 付款后仍返回 402，说明付款被拒绝（例如余额不足），原因在新的支付要求里
  let rejectedReason;
  if (res.status === 402) {
    const text = await res.clone().text();
    rejectedReason = readPaymentRequired(res, text)?.error || "服务拒绝了这笔付款";
  }

  print({
    status: res.status,
    ok: res.ok,
    settled: Boolean(settlement?.success),
    payment: selected ? describeRequirement(selected) : null,
    ...(rejectedReason && { rejected_reason: rejectedReason }),
    settlement,
    body: await readBody(res, values.output),
  });
  if (!res.ok) process.exit(1);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      url: { type: "string" },
      method: { type: "string" },
      body: { type: "string" },
      "body-file": { type: "string" },
      file: { type: "string", multiple: true },
      form: { type: "string", multiple: true },
      header: { type: "string", multiple: true },
      output: { type: "string" },
      network: { type: "string" },
      "max-amount": { type: "string" },
    },
  });

  switch (command) {
    case "config":
      return cmdConfig();
    case "address":
      return cmdAddress();
    case "quote":
    case "request":
      return cmdQuote(values);
    case "pay":
      return cmdPay(values);
    default:
      fail("用法：pay.mjs config | address | quote --url <url> [...] | request --url <url> [...] | pay --url <url> --max-amount <金额> [...]");
  }
}

main().catch((err) => fail(err.message));
