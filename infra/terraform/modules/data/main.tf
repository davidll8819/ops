variable "name" { type = string }
variable "vpc_id" { type = string }
variable "private_subnets" { type = list(string) }
variable "app_security_group" { type = string }
variable "high_availability" { type = bool }
resource "aws_security_group" "db" {
  name   = "${var.name}-db"
  vpc_id = var.vpc_id
  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [var.app_security_group]
  }
}
resource "aws_security_group" "redis" {
  name   = "${var.name}-redis"
  vpc_id = var.vpc_id
  ingress {
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [var.app_security_group]
  }
}
resource "aws_db_subnet_group" "main" {
  name       = var.name
  subnet_ids = var.private_subnets
}
resource "aws_db_parameter_group" "main" {
  name   = var.name
  family = "postgres17"
  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }
}
resource "aws_db_instance" "main" {
  identifier                      = var.name
  engine                          = "postgres"
  engine_version                  = "17"
  instance_class                  = "db.t4g.micro"
  allocated_storage               = 20
  max_allocated_storage           = 100
  storage_type                    = "gp3"
  storage_encrypted               = true
  db_name                         = "office"
  username                        = "office_admin"
  manage_master_user_password     = true
  db_subnet_group_name            = aws_db_subnet_group.main.name
  parameter_group_name            = aws_db_parameter_group.main.name
  vpc_security_group_ids          = [aws_security_group.db.id]
  publicly_accessible             = false
  multi_az                        = var.high_availability
  backup_retention_period         = 7
  deletion_protection             = true
  skip_final_snapshot             = false
  final_snapshot_identifier       = "${var.name}-final"
  auto_minor_version_upgrade      = true
  enabled_cloudwatch_logs_exports = ["postgresql", "upgrade"]
  lifecycle { prevent_destroy = true }
}
resource "random_password" "app" {
  length  = 40
  special = false
}
resource "aws_secretsmanager_secret" "app" { name = "${var.name}/database-app" }
resource "aws_secretsmanager_secret_version" "app" {
  secret_id     = aws_secretsmanager_secret.app.id
  secret_string = jsonencode({ username = "office_app", password = random_password.app.result })
}
resource "random_password" "redis" {
  length  = 40
  special = false
}
resource "aws_elasticache_subnet_group" "main" {
  name       = var.name
  subnet_ids = var.private_subnets
}
resource "aws_elasticache_replication_group" "main" {
  replication_group_id       = var.name
  description                = "Session, tenant profile cache and rate limits"
  engine                     = "redis"
  engine_version             = "7.1"
  node_type                  = "cache.t4g.micro"
  num_cache_clusters         = var.high_availability ? 2 : 1
  automatic_failover_enabled = var.high_availability
  multi_az_enabled           = var.high_availability
  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  auth_token                 = random_password.redis.result
  subnet_group_name          = aws_elasticache_subnet_group.main.name
  security_group_ids         = [aws_security_group.redis.id]
  snapshot_retention_limit   = 3
}
resource "aws_secretsmanager_secret" "redis" { name = "${var.name}/redis" }
resource "aws_secretsmanager_secret_version" "redis" {
  secret_id     = aws_secretsmanager_secret.redis.id
  secret_string = "rediss://:${random_password.redis.result}@${aws_elasticache_replication_group.main.primary_endpoint_address}:6379"
}
output "pg_host" { value = aws_db_instance.main.address }
output "app_secret_arn" { value = aws_secretsmanager_secret.app.arn }
output "admin_secret_arn" { value = aws_db_instance.main.master_user_secret[0].secret_arn }
output "redis_secret_arn" { value = aws_secretsmanager_secret.redis.arn }
