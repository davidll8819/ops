variable "name" { type = string }
variable "domain" { type = string }
variable "zone_id" { type = string }
variable "origin_domain" { type = string }
variable "origin_secret" {
  type      = string
  sensitive = true
}
variable "publish_dns" { type = bool }
resource "aws_acm_certificate" "main" {
  domain_name       = var.domain
  validation_method = "DNS"
  lifecycle { create_before_destroy = true }
}
resource "aws_route53_record" "validation" {
  for_each = { for d in aws_acm_certificate.main.domain_validation_options : d.domain_name => d }
  zone_id  = var.zone_id
  name     = each.value.resource_record_name
  type     = each.value.resource_record_type
  ttl      = 60
  records  = [each.value.resource_record_value]
}
resource "aws_acm_certificate_validation" "main" {
  certificate_arn         = aws_acm_certificate.main.arn
  validation_record_fqdns = [for r in aws_route53_record.validation : r.fqdn]
}
data "aws_cloudfront_cache_policy" "disabled" { name = "Managed-CachingDisabled" }
data "aws_cloudfront_cache_policy" "static" { name = "Managed-CachingOptimized" }
data "aws_cloudfront_origin_request_policy" "dynamic" { name = "Managed-AllViewerExceptHostHeader" }
resource "aws_cloudfront_origin_request_policy" "app" {
  name = "${var.name}-app"
  cookies_config { cookie_behavior = "all" }
  query_strings_config { query_string_behavior = "all" }
  headers_config {
    header_behavior = "whitelist"
    headers { items = ["Accept", "Origin", "X-CSRF-Token", "CloudFront-Viewer-Address"] }
  }
}
resource "aws_cloudfront_distribution" "main" {
  enabled             = true
  is_ipv6_enabled     = true
  aliases             = [var.domain]
  default_root_object = "index.html"
  price_class         = "PriceClass_All"
  origin {
    domain_name = var.origin_domain
    origin_id   = "application"
    custom_header {
      name  = "X-Origin-Verify"
      value = var.origin_secret
    }
    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
      origin_read_timeout    = 60
    }
  }
  default_cache_behavior {
    target_origin_id         = "application"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    viewer_protocol_policy   = "redirect-to-https"
    cache_policy_id          = data.aws_cloudfront_cache_policy.disabled.id
    origin_request_policy_id = aws_cloudfront_origin_request_policy.app.id
    compress                 = true
  }
  ordered_cache_behavior {
    # AiToEarn's tenant-bound model gateway needs its Authorization header.
    # This path must never cache authenticated model responses.
    path_pattern             = "/integrations/*"
    target_origin_id         = "application"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    viewer_protocol_policy   = "https-only"
    cache_policy_id          = data.aws_cloudfront_cache_policy.disabled.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.dynamic.id
    compress                 = true
  }
  ordered_cache_behavior {
    path_pattern           = "/assets/*"
    target_origin_id       = "application"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    viewer_protocol_policy = "https-only"
    cache_policy_id        = data.aws_cloudfront_cache_policy.static.id
    compress               = true
  }
  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.main.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }
  restrictions {
    geo_restriction { restriction_type = "none" }
  }
}
resource "aws_route53_record" "site" {
  count   = var.publish_dns ? 1 : 0
  zone_id = var.zone_id
  name    = var.domain
  type    = "A"
  alias {
    name                   = aws_cloudfront_distribution.main.domain_name
    zone_id                = aws_cloudfront_distribution.main.hosted_zone_id
    evaluate_target_health = false
  }
}
resource "aws_route53_record" "site_ipv6" {
  count   = var.publish_dns ? 1 : 0
  zone_id = var.zone_id
  name    = var.domain
  type    = "AAAA"
  alias {
    name                   = aws_cloudfront_distribution.main.domain_name
    zone_id                = aws_cloudfront_distribution.main.hosted_zone_id
    evaluate_target_health = false
  }
}
output "domain" { value = aws_cloudfront_distribution.main.domain_name }
output "id" { value = aws_cloudfront_distribution.main.id }
