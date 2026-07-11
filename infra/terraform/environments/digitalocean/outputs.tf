output "app_id" {
  description = "DigitalOcean App Platform app id."
  value       = digitalocean_app.app.id
}

output "app_live_url" {
  description = "DigitalOcean App Platform live URL."
  value       = digitalocean_app.app.live_url
}

output "app_default_ingress" {
  description = "DigitalOcean App Platform default ingress hostname."
  value       = digitalocean_app.app.default_ingress
}
