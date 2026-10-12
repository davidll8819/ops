// Run only after reviewing and applying the bootstrap infrastructure plan.
// This script builds/pushes a release; it never changes DNS or applies Terraform.
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
const tf = process.env.TERRAFORM_BIN || 'terraform'
const run = (bin, args) =>
  execFileSync(bin, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).trim()
const aws = (args) => run('aws', ['--profile', '0511', '--region', 'ap-east-1', ...args])
const outputs = JSON.parse(run(tf, ['-chdir=infra/terraform', 'output', '-json']))
const repository = outputs.ecr_repository.value
if (!/^\d+\.dkr\.ecr\.ap-east-1\.amazonaws\.com\/[a-z0-9-]+$/.test(repository))
  throw new Error('Unexpected ECR repository')
const tag = process.argv[2]
if (!tag || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}$/.test(tag))
  throw new Error('Usage: node scripts/cloud-release.mjs RELEASE_TAG')
const password = aws(['ecr', 'get-login-password'])
const login = spawnSync(
  'docker',
  ['login', '--username', 'AWS', '--password-stdin', repository.split('/')[0]],
  { input: password, stdio: ['pipe', 'inherit', 'inherit'] },
)
if (login.status) process.exit(login.status)
const build = spawnSync(
  'docker',
  ['buildx', 'build', '--platform', 'linux/arm64', '--push', '-t', `${repository}:${tag}`, '.'],
  { stdio: 'inherit' },
)
if (build.status) process.exit(build.status)
const digest = aws([
  'ecr',
  'describe-images',
  '--repository-name',
  repository.split('/')[1],
  '--image-ids',
  `imageTag=${tag}`,
  '--query',
  'imageDetails[0].imageDigest',
  '--output',
  'text',
])
if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error('Missing immutable image digest')
mkdirSync('.local', { recursive: true })
writeFileSync('.local/release.tfvars.json', JSON.stringify({ image_digest: digest }, null, 2))
console.log('ARM64 release pushed. Terraform image variables saved to .local/release.tfvars.json')
