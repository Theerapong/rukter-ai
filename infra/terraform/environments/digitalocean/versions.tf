terraform {
  required_version = ">= 1.6.0"

  required_providers {
    digitalocean = {
      source  = "digitalocean/digitalocean"
      version = "~> 2.90"
    }
  }

  backend "s3" {
    bucket         = "rukter-terraform-state-prod"
    key            = "rukter-ai-launch-agent/digitalocean/terraform.tfstate"
    region         = "ap-southeast-1"
    dynamodb_table = "rukter-terraform-lock-prod"
    encrypt        = true
  }
}

provider "digitalocean" {}
