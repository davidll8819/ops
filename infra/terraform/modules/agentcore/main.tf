variable "name" { type = string }
variable "model_id" { type = string }
variable "model_resource_arns" { type = list(string) }
data "aws_caller_identity" "current" {}
data "aws_region" "current" {}
resource "aws_iam_role" "harness" {
  name = "${var.name}_harness"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Effect    = "Allow", Principal = { Service = "bedrock-agentcore.amazonaws.com" }, Action = "sts:AssumeRole",
    Condition = { StringEquals = { "aws:SourceAccount" = data.aws_caller_identity.current.account_id }, ArnLike = { "aws:SourceArn" = "arn:aws:bedrock-agentcore:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:*" } }
  }] })
}
resource "aws_bedrockagentcore_memory" "main" {
  name                  = "${var.name}_memory"
  event_expiry_duration = 30
  lifecycle { prevent_destroy = true }
}
resource "aws_bedrockagentcore_memory_strategy" "facts" {
  memory_id           = aws_bedrockagentcore_memory.main.id
  name                = "personal_facts"
  type                = "SEMANTIC"
  namespace_templates = ["/facts/{actorId}/"]
}
resource "aws_bedrockagentcore_memory_strategy" "preferences" {
  memory_id           = aws_bedrockagentcore_memory.main.id
  name                = "personal_preferences"
  type                = "USER_PREFERENCE"
  namespace_templates = ["/preferences/{actorId}/"]
}
resource "aws_iam_role_policy" "harness" {
  role = aws_iam_role.harness.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"], Resource = var.model_resource_arns },
    { Effect = "Allow", Action = ["bedrock-agentcore:CreateEvent", "bedrock-agentcore:ListEvents", "bedrock-agentcore:GetEvent", "bedrock-agentcore:RetrieveMemoryRecords", "bedrock-agentcore:GetMemory", "bedrock-agentcore:ListMemoryRecords"], Resource = [aws_bedrockagentcore_memory.main.arn, "${aws_bedrockagentcore_memory.main.arn}/*"] },
    { Effect = "Allow", Action = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"], Resource = "arn:aws:logs:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/bedrock-agentcore/*" },
    { Effect = "Allow", Action = ["cloudwatch:PutMetricData"], Resource = "*", Condition = { StringEquals = { "cloudwatch:namespace" = "bedrock-agentcore" } } }
  ] })
}
resource "aws_bedrockagentcore_harness" "shared" {
  for_each           = toset(["memory", "stateless"])
  harness_name       = "${var.name}_${each.key}"
  execution_role_arn = aws_iam_role.harness.arn
  model {
    bedrock_model_config {
      model_id   = var.model_id
      max_tokens = 2048
    }
  }
  system_prompt { text = "Follow the server-provided assistant profile. Do not access other tenants or users." }
  allowed_tools   = []
  max_iterations  = 4
  max_tokens      = 8192
  timeout_seconds = 45
  memory {
    dynamic "agentcore_memory_configuration" {
      for_each = each.key == "memory" ? [1] : []
      content { arn = aws_bedrockagentcore_memory.main.arn }
    }
    dynamic "disabled" {
      for_each = each.key == "stateless" ? [1] : []
      content {}
    }
  }
  depends_on = [aws_iam_role_policy.harness, aws_bedrockagentcore_memory_strategy.facts, aws_bedrockagentcore_memory_strategy.preferences]
}
output "harness_arns" { value = { for k, v in aws_bedrockagentcore_harness.shared : k => v.arn } }
output "runtime_arns" { value = [for k, v in aws_bedrockagentcore_harness.shared : v.environment_actual[0].agentcore_runtime_environment[0].agent_runtime_arn] }
