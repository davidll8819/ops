output "url" { value = "https://${var.domain}" }
output "cloudfront_domain" { value = module.edge.domain }
output "cloudfront_id" { value = module.edge.id }
output "ecr_repository" { value = module.compute.repository }
output "cluster" { value = module.compute.cluster }
output "service" { value = module.compute.service }
output "migration_task" { value = module.compute.migration_task }
output "private_subnets" { value = module.network.private_subnets }
output "app_security_group" { value = module.network.app_security_group }
output "harness_arns" { value = var.enable_agentcore ? module.agentcore[0].harness_arns : {} }
output "operations_config_secret_arn" {
  description = "Write the existing 32-byte base64 configuration encryption key with Secrets Manager before starting ECS. Terraform never reads this secret value."
  value       = module.compute.operations_config_secret_arn
}
