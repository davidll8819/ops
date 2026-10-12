variable "name" { type = string }
variable "domain" { type = string }
data "aws_region" "current" {}
data "aws_caller_identity" "current" {}
locals { prefix = "${var.name}-${data.aws_caller_identity.current.account_id}" }
resource "aws_cognito_user_pool" "main" {
  name                     = var.name
  user_pool_tier           = "ESSENTIALS"
  auto_verified_attributes = ["email"]
  alias_attributes         = ["email"]
  username_configuration { case_sensitive = false }
  mfa_configuration   = "OFF"
  deletion_protection = "ACTIVE"
  password_policy {
    minimum_length    = 12
    require_lowercase = true
    require_uppercase = true
    require_numbers   = true
    require_symbols   = true
  }
  sign_in_policy { allowed_first_auth_factors = ["PASSWORD", "WEB_AUTHN"] }
  web_authn_configuration {
    relying_party_id  = "${local.prefix}.auth.${data.aws_region.current.region}.amazoncognito.com"
    user_verification = "required"
  }
  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }
  schema {
    name                = "email"
    attribute_data_type = "String"
    required            = true
    mutable             = true
    string_attribute_constraints {
      min_length = 5
      max_length = 256
    }
  }
  lifecycle { prevent_destroy = true }
}
resource "aws_cognito_user_pool_client" "web" {
  name                                 = "${var.name}-web"
  user_pool_id                         = aws_cognito_user_pool.main.id
  generate_secret                      = false
  supported_identity_providers         = ["COGNITO"]
  explicit_auth_flows                  = ["ALLOW_USER_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"]
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "profile"]
  callback_urls                        = ["https://${var.domain}/auth/callback"]
  logout_urls                          = ["https://${var.domain}"]
  prevent_user_existence_errors        = "ENABLED"
  enable_token_revocation              = true
  access_token_validity                = 1
  id_token_validity                    = 1
  refresh_token_validity               = 7
}
resource "aws_cognito_user_pool_domain" "main" {
  domain                = local.prefix
  user_pool_id          = aws_cognito_user_pool.main.id
  managed_login_version = 2
}
resource "aws_cognito_managed_login_branding" "main" {
  user_pool_id                = aws_cognito_user_pool.main.id
  client_id                   = aws_cognito_user_pool_client.web.id
  use_cognito_provided_values = true
  depends_on                  = [aws_cognito_user_pool_domain.main]
}
output "config" {
  value = {
    issuer    = "https://${aws_cognito_user_pool.main.endpoint}"
    client_id = aws_cognito_user_pool_client.web.id
    domain    = "https://${aws_cognito_user_pool_domain.main.domain}.auth.${data.aws_region.current.region}.amazoncognito.com"
  }
}
