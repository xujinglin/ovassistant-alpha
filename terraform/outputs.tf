output "alb_dns_name" {
  value = "${module.ecs.alb_dns_name}"
}

output "mysql_host" {
  value = "${module.rds.rds_address}"
}

output "redis_host" {
  value = "${module.elasticache.hostname}"
}
