// Run only in the dedicated admin migration task while the application service is stopped.
// The S3 object must come from pg_dump --data-only --column-inserts --no-owner
// --no-privileges --exclude-table=public.schema_migrations. Keep the checksum separate.
import { makePool } from '../apps/api/src/db.mjs'
import { CloudImportError, importCloudData, importIdentity } from './lib/cloud-import.mjs'

const env = process.env
const identity = importIdentity({ adminUserId: env.CLOUD_IMPORT_ADMIN_USER_ID, cognitoSub: env.CLOUD_IMPORT_COGNITO_SUB, adminEmail: env.CLOUD_IMPORT_ADMIN_EMAIL })
const bucket = env.CLOUD_IMPORT_BUCKET, key = env.CLOUD_IMPORT_KEY, sha256 = env.CLOUD_IMPORT_SHA256
if (!bucket || !key || !/^[a-f0-9]{64}$/.test(sha256 || '')) throw new Error('Set the explicit private S3 data object and its SHA-256')
const { S3Client, GetObjectCommand } = await import('@aws-sdk/client-s3')
const s3 = new S3Client({ region: env.AWS_REGION || 'ap-east-1', maxAttempts: 1 })
let pool
try {
  const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
  if (!['AES256', 'aws:kms', 'aws:kms:dsse'].includes(object.ServerSideEncryption)) throw new Error('Data dump must use S3 server-side encryption')
  const maximum = 256 * 1024 * 1024
  if (!object.Body || !object.ContentLength || object.ContentLength > maximum) throw new Error('Data dump size is invalid')
  const chunks = []
  let length = 0
  for await (const chunk of object.Body) {
    length += chunk.length
    if (length > maximum) throw new Error('Data dump exceeds the import size limit')
    chunks.push(chunk)
  }
  pool = await makePool()
  const result = await importCloudData(pool, Buffer.concat(chunks), { sha256, ...identity })
  console.log(JSON.stringify({ imported: true, ...result }))
} catch (error) {
  // SQL errors may embed whole rows, prompts or encrypted credentials. Never log them.
  const reason = error instanceof CloudImportError ? error.message : 'Inspect the migration inputs and permissions; provider or database error details are withheld.'
  const code = /^[A-Z0-9]{5}$/.test(error.code || '') ? error.code : undefined
  console.error(JSON.stringify({ imported: false, reason, ...(code ? { code } : {}) }))
  process.exitCode = 1
} finally {
  await pool?.end()
  s3.destroy()
}
