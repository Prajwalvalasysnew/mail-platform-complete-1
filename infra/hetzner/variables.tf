variable "hcloud_token" {
  type      = string
  sensitive = true
}
variable "cluster_name" {
  type    = string
  default = "mail-platform"
}
variable "location" {
  type    = string
  default = "fsn1"
}
variable "server_type" {
  type    = string
  default = "cpx31"
}
variable "ssh_key_name" {
  type = string
}
variable "admin_cidrs" {
  type        = list(string)
  description = "Trusted operator networks allowed to reach SSH."
}
