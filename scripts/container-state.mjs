export function isStoppedContainerStatus(status) {
  return status === "exited" || status === "dead";
}
