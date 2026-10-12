terraform {
  required_version = ">= 1.13.0"
  required_providers {
    aws    = { source = "hashicorp/aws", version = ">= 6.60, < 7.0" }
    random = { source = "hashicorp/random", version = "~> 3.7" }
  }
  # Production: terraform init -backend-config=... after creating the encrypted state bucket.
  backend "s3" {}
}
provider "aws" {
  region  = "ap-east-1"
  profile = var.aws_profile
  default_tags { tags = { Project = "wishtaday", Environment = var.environment, ManagedBy = "Terraform" } }
}
provider "aws" {
  alias   = "agent"
  region  = var.agent_region
  profile = var.aws_profile
  default_tags { tags = { Project = "wishtaday", Environment = var.environment, ManagedBy = "Terraform" } }
}
provider "aws" {
  alias   = "edge"
  region  = "us-east-1"
  profile = var.aws_profile
}
