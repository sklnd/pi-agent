{
  description = "gent — pi coding agent configuration and extensions";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs";
    llm-agents.url = "github:numtide/llm-agents.nix";
  };

  outputs = {
    self,
    nixpkgs,
    llm-agents,
  }: let
    systems = ["aarch64-darwin" "x86_64-darwin" "aarch64-linux" "x86_64-linux"];
    forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
  in {
    # Assembled pi config tree + passthrough packages from llm-agents.nix.
    #
    #   packages.pi-config      — $PI_CODING_AGENT_DIR tree: settings.json +
    #                              APPEND_SYSTEM.md +
    #                              extensions/{sandbox,agent-notify}/*.ts
    #                              (jiti-loaded, no build)
    #   packages.pi / srt — passthroughs from llm-agents.nix for convenience
    #   homeManagerModules.default — home-manager module that installs pi + srt,
    #                              sets env vars, and symlinks the config tree.
    #                              nix-config imports this instead of an inline
    #                              pi.nix so this flake owns the whole setup.
    packages = forAllSystems (pkgs: let
      system = pkgs.stdenv.hostPlatform.system;
      llmPkgs = (llm-agents.packages or {}).${system} or {};

      pi-config = pkgs.runCommandLocal "pi-config" {} ''
        mkdir -p $out/extensions/sandbox $out/extensions/agent-notify
        cp ${./src/sandbox}/*.ts $out/extensions/sandbox/
        cp ${./src/agent-notify}/*.ts $out/extensions/agent-notify/
        cp ${./pi/settings.json} $out/settings.json
        cp ${./pi/APPEND_SYSTEM.md} $out/APPEND_SYSTEM.md
      '';
    in {
      inherit pi-config;
      pi = llmPkgs.pi or null;
      srt = llmPkgs.sandbox-runtime or null;
      default = pi-config;
    });

    homeManagerModules.default = import ./nix/hm-module.nix {
      inherit self llm-agents;
    };

    # Fixture tests for the settings-merge shell used by the home-manager
    # activation. Run with `nix flake check`.
    checks = forAllSystems (pkgs: {
      settings-merge =
        pkgs.runCommand "check-settings-merge" {
          nativeBuildInputs = [pkgs.bash pkgs.coreutils pkgs.jq];
        } ''
          export MERGE_SCRIPT=${./nix/merge-settings.sh}
          export JQ=${pkgs.jq}/bin/jq
          bash ${./nix/merge-settings.test.sh}
          touch $out
        '';
    });

    formatter = forAllSystems (pkgs: pkgs.alejandra);
  };
}
