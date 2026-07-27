locals {
  nodes = {
    node-1 = "10.42.0.11"
    node-2 = "10.42.0.12"
    node-3 = "10.42.0.13"
  }
}

data "hcloud_ssh_key" "operator" {
  name = var.ssh_key_name
}

resource "hcloud_network" "platform" {
  name     = "${var.cluster_name}-private"
  ip_range = "10.42.0.0/16"
}

resource "hcloud_network_subnet" "platform" {
  network_id   = hcloud_network.platform.id
  type         = "cloud"
  network_zone = "eu-central"
  ip_range     = "10.42.0.0/24"
}

resource "hcloud_firewall" "nodes" {
  name = "${var.cluster_name}-nodes"
  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "22"
    source_ips = var.admin_cidrs
  }
  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "6443"
    source_ips = var.admin_cidrs
  }
  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "any"
    source_ips = ["10.42.0.0/16"]
  }
  rule {
    direction  = "in"
    protocol   = "udp"
    port       = "any"
    source_ips = ["10.42.0.0/16"]
  }
  rule {
    direction  = "in"
    protocol   = "icmp"
    source_ips = ["10.42.0.0/16"]
  }
}

resource "hcloud_server" "node" {
  for_each     = local.nodes
  name         = "${var.cluster_name}-${each.key}"
  image        = "ubuntu-24.04"
  server_type  = var.server_type
  location     = var.location
  ssh_keys     = [data.hcloud_ssh_key.operator.id]
  firewall_ids = [hcloud_firewall.nodes.id]
  backups      = true
  labels = {
    workload = "mail-platform"
    ha_group = var.cluster_name
  }
  user_data = templatefile("${path.module}/cloud-init.yaml.tftpl", {
    node_name = "${var.cluster_name}-${each.key}"
  })
  lifecycle {
    ignore_changes = [user_data]
  }
}

resource "hcloud_server_network" "node" {
  for_each   = local.nodes
  server_id  = hcloud_server.node[each.key].id
  network_id = hcloud_network.platform.id
  ip         = each.value
  depends_on = [hcloud_network_subnet.platform]
}

resource "hcloud_load_balancer" "public" {
  name               = "${var.cluster_name}-public"
  load_balancer_type = "lb11"
  location           = var.location
  algorithm { type = "round_robin" }
}

resource "hcloud_load_balancer_network" "public" {
  load_balancer_id = hcloud_load_balancer.public.id
  network_id       = hcloud_network.platform.id
}

resource "hcloud_load_balancer_target" "nodes" {
  type             = "label_selector"
  load_balancer_id = hcloud_load_balancer.public.id
  label_selector   = "workload=mail-platform"
  use_private_ip   = true
  depends_on       = [hcloud_server_network.node]
}

resource "hcloud_load_balancer_service" "https" {
  load_balancer_id = hcloud_load_balancer.public.id
  protocol         = "tcp"
  listen_port      = 443
  destination_port = 443
  health_check {
    protocol = "https"
    port     = 443
    interval = 15
    timeout  = 10
    retries  = 3
    http {
      path         = "/ready"
      status_codes = ["200"]
      tls          = true
    }
  }
}

resource "hcloud_load_balancer_service" "smtp_submission" {
  load_balancer_id = hcloud_load_balancer.public.id
  protocol         = "tcp"
  listen_port      = 587
  destination_port = 587
  health_check {
    protocol = "tcp"
    port     = 587
    interval = 15
    timeout  = 10
    retries  = 3
  }
}
