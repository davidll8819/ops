resource "aws_ecr_repository" "main" {
  name                 = var.name
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration { scan_on_push = true }
}
resource "aws_cloudwatch_log_group" "main" {
  name              = "/ecs/${var.name}"
  retention_in_days = 30
}
resource "random_password" "origin" {
  length  = 48
  special = false
}
resource "aws_secretsmanager_secret" "origin" { name = "${var.name}/origin" }
resource "aws_secretsmanager_secret" "operations_config" {
  name                    = "${var.name}/operations-config-key"
  description             = "AES-256 key for enterprise model settings; value is provisioned outside Terraform."
  recovery_window_in_days = 30
  lifecycle { prevent_destroy = true }
}
resource "aws_secretsmanager_secret_version" "origin" {
  secret_id     = aws_secretsmanager_secret.origin.id
  secret_string = random_password.origin.result
}
resource "aws_acm_certificate" "origin" {
  domain_name       = "origin.${var.domain}"
  validation_method = "DNS"
  lifecycle { create_before_destroy = true }
}
resource "aws_route53_record" "validation" {
  for_each = { for d in aws_acm_certificate.origin.domain_validation_options : d.domain_name => d }
  zone_id  = var.zone_id
  name     = each.value.resource_record_name
  type     = each.value.resource_record_type
  ttl      = 60
  records  = [each.value.resource_record_value]
}
resource "aws_acm_certificate_validation" "origin" {
  certificate_arn         = aws_acm_certificate.origin.arn
  validation_record_fqdns = [for r in aws_route53_record.validation : r.fqdn]
}
resource "aws_lb" "main" {
  name                       = var.name
  load_balancer_type         = "application"
  subnets                    = var.public_subnets
  security_groups            = [var.alb_security_group]
  idle_timeout               = 120
  drop_invalid_header_fields = true
  enable_deletion_protection = true
}
resource "aws_route53_record" "origin" {
  zone_id = var.zone_id
  name    = "origin.${var.domain}"
  type    = "A"
  alias {
    name                   = aws_lb.main.dns_name
    zone_id                = aws_lb.main.zone_id
    evaluate_target_health = true
  }
}
resource "aws_lb_target_group" "main" {
  name        = var.name
  port        = 3000
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = var.vpc_id
  health_check {
    path    = "/health/ready"
    matcher = "200"
  }
}
resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.main.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate_validation.origin.certificate_arn
  default_action {
    type = "fixed-response"
    fixed_response {
      content_type = "text/plain"
      message_body = "Forbidden"
      status_code  = "403"
    }
  }
}
resource "aws_lb_listener_rule" "origin" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 1
  condition {
    http_header {
      http_header_name = "X-Origin-Verify"
      values           = [random_password.origin.result]
    }
  }
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.main.arn
  }
}
resource "aws_ecs_cluster" "main" {
  name = var.name
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}
locals {
  assume_ecs = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = { Service = "ecs-tasks.amazonaws.com" }, Action = "sts:AssumeRole" }] })
  common_environment = [for k, v in {
    NODE_ENV          = "production", APP_ORIGIN = "https://${var.domain}", PORT = "3000", PGHOST = var.pg_host, PGDATABASE = "office", PGSSLROOTCERT = "/app/certs/rds-global-bundle.pem",
    AWS_REGION        = "ap-east-1", AGENT_REGION = var.agent_region, AUTH_MODE = "cognito",
    COGNITO_ISSUER    = var.cognito.issuer, COGNITO_CLIENT_ID = var.cognito.client_id, COGNITO_DOMAIN = var.cognito.domain,
    AGENT_HARNESS_ARN = lookup(var.harness_arns, "memory", ""), AGENT_STATELESS_HARNESS_ARN = lookup(var.harness_arns, "stateless", ""),
    ALLOWED_MODEL_IDS = var.enable_agentcore ? var.model_id : "", BUILDER_MODEL_ID = var.enable_agentcore ? var.model_id : "", MODEL_RATES_JSON = jsonencode(var.model_rates)
  } : { name = k, value = v }]
}
resource "aws_iam_role" "execution" {
  name               = "${var.name}-execution"
  assume_role_policy = local.assume_ecs
}
resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}
resource "aws_iam_role_policy" "secrets" {
  role   = aws_iam_role.execution.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = [var.app_secret_arn, var.admin_secret_arn, var.redis_secret_arn, aws_secretsmanager_secret.origin.arn, aws_secretsmanager_secret.operations_config.arn] }] })
}
resource "aws_iam_role" "task" {
  name               = "${var.name}-task"
  assume_role_policy = local.assume_ecs
}
resource "aws_iam_role_policy" "task" {
  count = var.enable_agentcore ? 1 : 0
  role  = aws_iam_role.task.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["bedrock-agentcore:InvokeHarness"], Resource = values(var.harness_arns) },
    { Effect = "Allow", Action = ["bedrock-agentcore:InvokeAgentRuntime"], Resource = var.runtime_arns },
    { Effect = "Allow", Action = ["bedrock:InvokeModel"], Resource = var.model_resource_arns }
  ] })
}
moved {
  from = aws_iam_role_policy.task
  to   = aws_iam_role_policy.task[0]
}
resource "aws_ecs_task_definition" "app" {
  count                    = var.image_digest != "" ? 1 : 0
  family                   = var.name
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }
  container_definitions = jsonencode([{
    name             = "app", image = "${aws_ecr_repository.main.repository_url}@${var.image_digest}", essential = true, readonlyRootFilesystem = true,
    portMappings     = [{ containerPort = 3000 }], environment = local.common_environment,
    secrets          = [{ name = "PGUSER", valueFrom = "${var.app_secret_arn}:username::" }, { name = "PGPASSWORD", valueFrom = "${var.app_secret_arn}:password::" }, { name = "REDIS_URL", valueFrom = var.redis_secret_arn }, { name = "ORIGIN_VERIFY_SECRET", valueFrom = aws_secretsmanager_secret.origin.arn }, { name = "OPERATIONS_CONFIG_KEY", valueFrom = aws_secretsmanager_secret.operations_config.arn }],
    logConfiguration = { logDriver = "awslogs", options = { awslogs-group = aws_cloudwatch_log_group.main.name, awslogs-region = "ap-east-1", awslogs-stream-prefix = "app" } },
    healthCheck      = { command = ["CMD-SHELL", "node -e \"fetch('http://127.0.0.1:3000/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""], interval = 30, timeout = 5, retries = 3, startPeriod = 30 }
  }])
}
resource "aws_ecs_task_definition" "migration" {
  count                    = var.image_digest != "" ? 1 : 0
  family                   = "${var.name}-migration"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = var.data_import_object_arn != "" ? aws_iam_role.data_import[0].arn : null
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }
  container_definitions = jsonencode([{
    name             = "migration", image = "${aws_ecr_repository.main.repository_url}@${var.image_digest}", essential = true,
    command          = ["node", "database/bootstrap.mjs"], environment = local.common_environment,
    secrets          = [{ name = "PGUSER", valueFrom = "${var.admin_secret_arn}:username::" }, { name = "PGPASSWORD", valueFrom = "${var.admin_secret_arn}:password::" }, { name = "APP_DB_PASSWORD", valueFrom = "${var.app_secret_arn}:password::" }],
    logConfiguration = { logDriver = "awslogs", options = { awslogs-group = aws_cloudwatch_log_group.main.name, awslogs-region = "ap-east-1", awslogs-stream-prefix = "migration" } }
  }])
}
resource "aws_iam_role" "data_import" {
  count              = var.data_import_object_arn != "" ? 1 : 0
  name               = "${var.name}-data-import"
  assume_role_policy = local.assume_ecs
}
resource "aws_iam_role_policy" "data_import" {
  count = var.data_import_object_arn != "" ? 1 : 0
  role  = aws_iam_role.data_import[0].id
  policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Effect = "Allow", Action = ["s3:GetObject"], Resource = [var.data_import_object_arn]
  }] })
}
resource "aws_ecs_service" "main" {
  count                             = var.image_digest != "" ? 1 : 0
  name                              = var.name
  cluster                           = aws_ecs_cluster.main.id
  task_definition                   = aws_ecs_task_definition.app[0].arn
  desired_count                     = var.desired_count
  launch_type                       = "FARGATE"
  platform_version                  = "LATEST"
  health_check_grace_period_seconds = 60
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  network_configuration {
    subnets          = var.private_subnets
    security_groups  = [var.app_security_group]
    assign_public_ip = false
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.main.arn
    container_name   = "app"
    container_port   = 3000
  }
  depends_on = [aws_lb_listener_rule.origin]
  lifecycle {
    precondition {
      condition     = var.license_reviewed || var.desired_count == 0
      error_message = "Review upstream Spine commercial licensing or replace assets before starting the public service."
    }
  }
}
output "repository" { value = aws_ecr_repository.main.repository_url }
output "origin_domain" { value = aws_route53_record.origin.fqdn }
output "origin_secret" {
  value     = random_password.origin.result
  sensitive = true
}
output "cluster" { value = aws_ecs_cluster.main.name }
output "service" { value = var.name }
output "migration_task" { value = try(aws_ecs_task_definition.migration[0].arn, null) }
output "operations_config_secret_arn" { value = aws_secretsmanager_secret.operations_config.arn }
