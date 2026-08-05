Files here are shipped to BOTH the client and the server.

  overrides/          -> both packs
  client-overrides/   -> client pack only  (options.txt, client mod configs)
  server-overrides/   -> server pack only  (server.properties, ops.json)

Paths are relative to the instance root, so overrides/config/x.json lands at
.minecraft/config/x.json on a client and config/x.json on a server.
