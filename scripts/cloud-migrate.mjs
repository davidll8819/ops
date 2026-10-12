// Runs the dedicated schema migration task, never the application with admin credentials.
import { execFileSync } from 'node:child_process'
const run = (bin, args) =>
  execFileSync(bin, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).trim()
const aws = (args) => run('aws', ['--profile', '0511', '--region', 'ap-east-1', ...args])
const o = JSON.parse(
  run(process.env.TERRAFORM_BIN || 'terraform', ['-chdir=infra/terraform', 'output', '-json']),
)
if (!o.migration_task?.value) throw new Error('Apply image digest with desired_count=0 first')
const net = {
  awsvpcConfiguration: {
    subnets: o.private_subnets.value,
    securityGroups: [o.app_security_group.value],
    assignPublicIp: 'DISABLED',
  },
}
const result = JSON.parse(
  aws([
    'ecs',
    'run-task',
    '--cluster',
    o.cluster.value,
    '--task-definition',
    o.migration_task.value,
    '--launch-type',
    'FARGATE',
    '--network-configuration',
    JSON.stringify(net),
  ]),
)
if (result.failures?.length || !result.tasks?.[0])
  throw new Error('Migration task could not start: ' + JSON.stringify(result.failures))
const arn = result.tasks[0].taskArn
aws(['ecs', 'wait', 'tasks-stopped', '--cluster', o.cluster.value, '--tasks', arn])
const task = JSON.parse(
  aws(['ecs', 'describe-tasks', '--cluster', o.cluster.value, '--tasks', arn]),
).tasks[0]
if (task.containers?.find((c) => c.name === 'migration')?.exitCode !== 0)
  throw new Error('Migration failed; inspect CloudWatch migration logs before deploying')
console.log('Database migration completed successfully')
