# Pi agent configuration and extensions — home-manager module
#
# Replaces the inline pi.nix that used to live in nix-config. Import with:
#
#   imports = [ pi-agent.homeManagerModules.default ];
#   programs.pi-agent.enable = true;
#
# What it owns:
#   - installs the `pi` binary and `srt` (sandbox-runtime) from llm-agents.nix
#   - sets PI_CODING_AGENT_DIR and PI_SANDBOX_SRT_BIN
#   - symlinks the vendored sandbox extension into ~/.config/pi/extensions/sandbox
#   - merges curated pi/settings.json (+ optional cfg.settings) into a mutable
#     ~/.config/pi/settings.json on activation, preserving runtime state (e.g. defaultModel)
#   - installs extra packages (bubblewrap + socat on Linux, plus anything extra)
#
# Curated packages and settings are declared in pi/settings.json
# in this repo. On `home-manager switch`, keys defined in pi/settings.json overwrite
# the mutable settings file so computers stay in sync, while keys not in pi/settings.json
# (like interactively saved defaultModel/defaultProvider) are preserved.
# `packages` is the exception: it is merged as a union so packages installed
# interactively (e.g. via the TUI) survive a switch. A package removed from the
# curated list is still dropped, tracked via .pi-curated-packages.json.
{
  self,
  llm-agents,
}: {
  config,
  lib,
  pkgs,
  ...
}: let
  cfg = config.programs.pi-agent;
  system = pkgs.stdenv.hostPlatform.system;
  llmPkgs = (llm-agents.packages or {}).${system} or {};
  piConfig = self.packages.${system}.pi-config;
in {
  options.programs.pi-agent = {
    enable =
      lib.mkEnableOption "pi-agent (pi coding agent with sandbox extensions)"
      // {default = false;};

    package = lib.mkOption {
      type = lib.types.nullOr lib.types.package;
      default = llmPkgs.pi or null;
      description = ''
        The pi package to install. Defaults to llm-agents.nix's pi.
        Set to null to skip installing pi (e.g. if you provide it elsewhere).
      '';
    };

    srtPackage = lib.mkOption {
      type = lib.types.nullOr lib.types.package;
      default = llmPkgs.sandbox-runtime or null;
      description = ''
        The srt (sandbox-runtime) package. Defaults to llm-agents.nix's
        sandbox-runtime. Set to null to skip srt; commands that need the OS
        sandbox are then blocked (the sandbox fails closed).
      '';
    };

    extraPackages = lib.mkOption {
      type = lib.types.listOf lib.types.package;
      default = [];
      description = ''
        Extra packages to install alongside pi and srt. bubblewrap and socat
        are added automatically on Linux when srt is enabled.
      '';
    };

    extensions = lib.mkOption {
      type = lib.types.attrsOf (lib.types.either lib.types.path lib.types.str);
      default = {};
      description = ''
        Extra pi extensions to symlink into ~/.config/pi/extensions/.
        Attribute name becomes the subdirectory name; value is the store
        path containing the extension's .ts files (or index.ts in a subdir).

        The sandbox extension is always installed from this flake's
        pi-config; this option is for additional nix-provided extensions.
      '';
      example = {
        rtk = "${llmPkgs.rtk or pkgs.emptyDirectory}/lib/pi/extensions/rtk";
      };
    };

    settings = lib.mkOption {
      type = lib.types.submodule {
        freeformType = (pkgs.formats.json {}).type;
      };
      default = {};
      description = ''
        Extra pi settings to merge into ~/.config/pi/settings.json alongside
        the curated pi/settings.json in this repo. Keys defined here overwrite
        the corresponding keys in ~/.config/pi/settings.json on activation, while
        unspecified keys (such as interactively chosen models) are preserved.
        `packages` is merged as a union with the on-disk value instead of
        overwriting, so locally installed packages survive a switch.
      '';
      example = {
        defaultProvider = "anthropic";
        defaultModel = "claude-sonnet-4-6";
      };
    };

    configDir = lib.mkOption {
      type = lib.types.str;
      default = "${config.xdg.configHome}/pi";
      description = "Value for the PI_CODING_AGENT_DIR environment variable.";
    };
  };

  config = lib.mkIf cfg.enable {
    home = {
      packages =
        lib.optional (cfg.package != null) cfg.package
        ++ lib.optional (cfg.srtPackage != null) cfg.srtPackage
        ++ cfg.extraPackages
        # srt needs bubblewrap + socat on Linux (ripgrep comes via dev-tools).
        ++ lib.optional (pkgs.stdenv.isLinux && cfg.srtPackage != null) pkgs.bubblewrap
        ++ lib.optional (pkgs.stdenv.isLinux && cfg.srtPackage != null) pkgs.socat;

      sessionVariables = lib.mkMerge [
        {PI_CODING_AGENT_DIR = cfg.configDir;}
        (lib.mkIf (cfg.srtPackage != null) {
          PI_SANDBOX_SRT_BIN = "${cfg.srtPackage}/bin/srt";
        })
      ];

      # Mutable settings.json (pi writes runtime state; a store symlink would EPERM).
      # Curated keys win, except `packages`, which is a union to keep local installs.
      activation.initPiSettings = lib.hm.dag.entryAfter ["writeBoundary"] (let
        extraJson = (pkgs.formats.json {}).generate "pi-extra-settings.json" cfg.settings;
        mergeScript = ./merge-settings.sh;
        jq = "${pkgs.jq}/bin/jq";
      in ''
        SETTINGS_FILE="${cfg.configDir}/settings.json" \
        STATE_FILE="${cfg.configDir}/.pi-curated-packages.json" \
        BASE="${piConfig}/settings.json" \
        EXTRA="${extraJson}" \
        JQ="${jq}" \
        DRY_RUN_CMD="$DRY_RUN_CMD" \
        DRY_RUN="''${DRY_RUN:-}" \
        ${pkgs.bash}/bin/bash ${mergeScript}
      '');
    };

    xdg.configFile =
      {
        "pi/extensions/sandbox".source = "${piConfig}/extensions/sandbox";
      }
      // lib.mapAttrs' (name: path: {
        name = "pi/extensions/${name}";
        value.source = path;
      })
      cfg.extensions;
  };
}
