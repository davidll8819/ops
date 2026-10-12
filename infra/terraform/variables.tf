variable "aws_profile" { default = "0511" }
variable "environment" { default = "production" }
variable "domain" { default = "wishtaday.com" }
variable "zone_id" { type = string }
variable "agent_region" {
  default = "us-west-2"
  validation {
    condition     = contains(["us-west-2", "us-east-2"], var.agent_region)
    error_message = "AgentCore is restricted to the user-approved US regions."
  }
}
variable "image_digest" {
  type    = string
  default = ""
  validation {
    condition     = var.image_digest == "" || can(regex("^sha256:[a-f0-9]{64}$", var.image_digest))
    error_message = "Use an immutable image digest after building ARM64."
  }
}
variable "desired_count" { default = 2 }
variable "high_availability" {
  type        = bool
  default     = true
  description = "Use standby database and cache nodes. Disable only for explicitly chosen single-instance trials."
}
variable "enable_agentcore" {
  type        = bool
  default     = false
  description = "Enable the separate AWS assistant builder/runtime after its model access is verified. Existing company model gateways do not require it."
}
variable "model_id" {
  type    = string
  default = ""
  validation {
    condition     = !var.enable_agentcore || trimspace(var.model_id) != ""
    error_message = "AgentCore requires an explicitly verified Bedrock model ID."
  }
}
variable "model_resource_arns" {
  type    = list(string)
  default = []
  validation {
    condition     = !var.enable_agentcore || length(var.model_resource_arns) > 0
    error_message = "AgentCore requires the verified model IAM resource ARN(s)."
  }
}
variable "model_rates" {
  type    = map(object({ inputUsdPerMillion = number, outputUsdPerMillion = number }))
  default = {}
}
variable "publish_dns" { default = false }
variable "license_reviewed" { default = false }
variable "data_import_object_arn" {
  type        = string
  default     = ""
  description = "Temporary, exact private S3 SQL backup object readable only by the migration task. Clear after verified import."
  validation {
    condition     = var.data_import_object_arn == "" || can(regex("^arn:aws:s3:::[a-z0-9][a-z0-9.-]+/[^*?]+$", var.data_import_object_arn))
    error_message = "Data import access must name exactly one S3 object; wildcards are prohibited."
  }
}
