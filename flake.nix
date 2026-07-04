{
  description = "gent — pi coding agent configuration and extensions";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs";
  };

  outputs = {
    self,
    nixpkgs,
  }: let
    systems = ["aarch64-darwin" "x86_64-darwin" "aarch64-linux" "x86_64-linux"];
    forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
  in {
    # Assembled pi config tree, consumed by the nix-config home-manager module.
    # Layout matches what pi expects under $PI_CODING_AGENT_DIR:
    #   $out/settings.json
    #   $out/extensions/sandbox/*.ts   (jiti-loaded, no build step)
    #
    # The default sandbox policy is baked into DEFAULT_CONFIG in config.ts (no
    # separate sandbox.json) — nix-managed via the vendored source. Dev tooling
    # (node 26 + pnpm 11) is provided via mise (.mise.toml); the extension is
    # dependency-free at runtime (pi provides its own API, srt is a separate
    # binary), so nix only needs to vendor the source — no npm in nix.
    packages = forAllSystems (pkgs: let
      pi-config = pkgs.runCommandLocal "pi-config" {} ''
        mkdir -p $out/extensions/sandbox
        cp ${./src/sandbox}/*.ts $out/extensions/sandbox/
        cp ${./pi/settings.json} $out/settings.json
      '';
    in {
      inherit pi-config;
      default = pi-config;
    });

    formatter = forAllSystems (pkgs: pkgs.alejandra);
  };
}
