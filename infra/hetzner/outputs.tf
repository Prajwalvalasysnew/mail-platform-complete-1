output "load_balancer_ipv4" {
  value = hcloud_load_balancer.public.ipv4
}
output "node_private_ips" {
  value = local.nodes
}
output "node_public_ips" {
  value = { for name, server in hcloud_server.node : name => server.ipv4_address }
}
