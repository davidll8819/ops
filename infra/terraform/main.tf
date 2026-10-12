locals { name = "wishtaday-${var.environment}" }
module "network" {
  source = "./modules/network"
  name   = local.name
}
module "data" {
  source             = "./modules/data"
  name               = local.name
  vpc_id             = module.network.vpc_id
  private_subnets    = module.network.private_subnets
  app_security_group = module.network.app_security_group
  high_availability  = var.high_availability
}
module "identity" {
  source = "./modules/identity"
  name   = local.name
  domain = var.domain
}
module "agentcore" {
  count               = var.enable_agentcore ? 1 : 0
  source              = "./modules/agentcore"
  providers           = { aws = aws.agent }
  name                = replace(local.name, "-", "_")
  model_id            = var.model_id
  model_resource_arns = var.model_resource_arns
}
# Preserve existing deployments when the optional module is enabled.
moved {
  from = module.agentcore
  to   = module.agentcore[0]
}
module "compute" {
  source                 = "./modules/compute"
  name                   = local.name
  domain                 = var.domain
  zone_id                = var.zone_id
  vpc_id                 = module.network.vpc_id
  public_subnets         = module.network.public_subnets
  private_subnets        = module.network.private_subnets
  app_security_group     = module.network.app_security_group
  alb_security_group     = module.network.alb_security_group
  image_digest           = var.image_digest
  desired_count          = var.desired_count
  pg_host                = module.data.pg_host
  app_secret_arn         = module.data.app_secret_arn
  admin_secret_arn       = module.data.admin_secret_arn
  redis_secret_arn       = module.data.redis_secret_arn
  enable_agentcore       = var.enable_agentcore
  harness_arns           = var.enable_agentcore ? module.agentcore[0].harness_arns : {}
  runtime_arns           = var.enable_agentcore ? module.agentcore[0].runtime_arns : []
  agent_region           = var.agent_region
  model_id               = var.model_id
  model_resource_arns    = var.model_resource_arns
  model_rates            = var.model_rates
  cognito                = module.identity.config
  license_reviewed       = var.license_reviewed
  data_import_object_arn = var.data_import_object_arn
}
module "edge" {
  source        = "./modules/edge"
  providers     = { aws = aws.edge }
  name          = local.name
  domain        = var.domain
  zone_id       = var.zone_id
  origin_domain = module.compute.origin_domain
  origin_secret = module.compute.origin_secret
  publish_dns   = var.publish_dns
}
