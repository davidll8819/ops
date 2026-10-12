// Run against a NEW tenant Mongo database, never the original shared database.
import { MongoClient, ObjectId } from 'mongodb'
import { readFile, writeFile, chmod } from 'node:fs/promises'
import { z } from 'zod'
const tenantId = z.uuid().parse(process.argv[2])
const path = process.env.OPERATIONS_RUNTIMES_FILE
if (!path) throw new Error('OPERATION_RUNTIMES_FILE is required')
const registry = JSON.parse(await readFile(path, 'utf8'))
const entry = registry[tenantId]
const config = entry?.infrastructure?.mongodb
if (!config || config.dbName !== `office_${tenantId.replaceAll('-', '')}`) throw new Error('Only a dedicated office_<tenant uuid> database can be provisioned')
const client = new MongoClient(config.uri, { serverSelectionTimeoutMS: 10000 })
try {
  await client.connect()
  const db = client.db(config.dbName), users = db.collection('user')
  const id = entry.userId ? new ObjectId(entry.userId) : new ObjectId()
  const current = await users.findOne({ _id: id })
  if (current && current.officeTenantId !== tenantId) throw new Error('Existing identity does not belong to this tenant')
  if (!current && await users.countDocuments({}) !== 0) throw new Error('Refusing to provision a nonempty legacy user database')
  await users.updateOne({ _id: id }, { $setOnInsert: { name: 'Office operations', officeTenantId: tenantId, status: 1, userType: 'CREATOR', isDelete: false, usedStorage: 0, storage: { total: 536870912 }, locale: 'zh-CN', createdAt: new Date(), updatedAt: new Date() } }, { upsert: true })
  entry.userId = id.toHexString()
  await writeFile(path, JSON.stringify(registry, null, 2) + '\n', { mode: 0o600 }); await chmod(path, 0o600)
  console.log('Tenant service identity provisioned; no registration or password needed')
} finally { await client.close() }
