import { randomBytes, scryptSync } from 'node:crypto'
import { writeFile, mkdir, access } from 'node:fs/promises'
try {
  await access('.env')
  console.log('.env already exists; keeping it unchanged')
  process.exit(0)
} catch {}
const db = randomBytes(24).toString('hex'),
  app = randomBytes(24).toString('hex'),
  password = randomBytes(18).toString('base64url'),
  salt = randomBytes(16).toString('hex')
await mkdir('.local', { recursive: true })
await writeFile('.local/operations-config.key', randomBytes(32).toString('base64'), { mode: 0o600, flag: 'wx' })
await writeFile('.local/operations-runtimes.json', '{}\n', { mode: 0o600, flag: 'wx' })
await writeFile(
  '.env',
  `NODE_ENV=development\nAPP_ORIGIN=http://localhost:3000\nAUTH_MODE=local\nLOCAL_EMAIL=owner@local.test\nLOCAL_PASSWORD_SALT=${salt}\nLOCAL_PASSWORD_HASH=${scryptSync(password, salt, 32).toString('hex')}\nLOCAL_DB_PASSWORD=${db}\nAPP_DB_PASSWORD=${app}\nPGHOST=127.0.0.1\nPGPORT=55432\nPGDATABASE=office\nPGUSER=office_app\nPGPASSWORD=${app}\nREDIS_URL=redis://127.0.0.1:56379\nAWS_PROFILE=0511\nAWS_REGION=ap-east-1\nAGENT_REGION=us-west-2\nALLOWED_MODEL_IDS=us.amazon.nova-lite-v1:0\nMODEL_RATES_JSON={}\nLOCAL_ACCOUNTS_FILE=.local/accounts.json\nOPERATIONS_CONFIG_KEY_FILE=.local/operations-config.key\nOPERATIONS_RUNTIMES_FILE=.local/operations-runtimes.json\n`,
  { mode: 0o600 },
)
await writeFile(
  '.local/login.txt',
  `Local validation only\nURL: http://localhost:3000\nEmail: owner@local.test\nPassword: ${password}\n`,
  { mode: 0o600 },
)
console.log('Local settings created; credentials saved to ignored .local/login.txt')
