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
        sandbox-runtime. Set to null to skip srt (disables OS sandboxing).
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
    home.packages =
      lib.optional (cfg.package != null) cfg.package
      ++ lib.optional (cfg.srtPackage != null) cfg.srtPackage
      ++ cfg.extraPackages
      # srt needs bubblewrap + socat on Linux (ripgrep comes via dev-tools).
      ++ lib.optional (pkgs.stdenv.isLinux && cfg.srtPackage != null) pkgs.bubblewrap
      ++ lib.optional (pkgs.stdenv.isLinux && cfg.srtPackage != null) pkgs.socat;

    home.sessionVariables = lib.mkMerge [
      {PI_CODING_AGENT_DIR = cfg.configDir;}
      (lib.mkIf (cfg.srtPackage != null) {
        PI_SANDBOX_SRT_BIN = "${cfg.srtPackage}/bin/srt";
      })
    ];

    xdg.configFile =
      {
        "pi/extensions/sandbox".source = "${piConfig}/extensions/sandbox";
      }
      // lib.mapAttrs' (name: path: {
        name = "pi/extensions/${name}";
        value.source = path;
      })
      cfg.extensions;

    # pi writes runtime state (e.g. defaultModel when chosen via Ctrl+S, thinking level,
    # and telemetry) to settings.json. A read-only store symlink causes EPERM on save.
    # Instead, we manage ~/.config/pi/settings.json as a mutable file on activation:
    # curated keys from pi/settings.json (and cfg.settings) overwrite the on-disk file
    # on every switch (preventing drift across computers), while machine-local runtime
    # preferences (such as defaultModel) are preserved.
    home.activation.initPiSettings = lib.hm.dag.entryAfter ["writeBoundary"] (let
      hasExtra = cfg.settings != {};
      extraJson =
        if hasExtra
        then (pkgs.formats.json {}).generate "pi-extra-settings.json" cfg.settings
        else null;
      jq = "${pkgs.jq}/bin/jq";
    in ''
      settingsDir="${cfg.configDir}"
      settingsFile="$settingsDir/settings.json"

      $DRY_RUN_CMD mkdir -p "$settingsDir"

      userJson="{}"
      if [ -e "$settingsFile" ] && ${jq} empty "$settingsFile" 2>/dev/null; then
        userJson=$(${jq} '.' "$settingsFile")
      fi

      # Unlink any existing symlink (e.g. migrating from read-only xdg.configFile)
      if [ -L "$settingsFile" ]; then
        $DRY_RUN_CMD rm -f "$settingsFile"
      fi

      if [ -v DRY_RUN ]; then
        echo "(dry-run) merge ${piConfig}/settings.json into $settingsFile"
      else
        ${
        if hasExtra
        then ''
          merged=$(echo "$userJson" | ${jq} \
            --slurpfile base "${piConfig}/settings.json" \
            --slurpfile extra "${extraJson}" \
            '. * $base[0] * $extra[0]')
        ''
        else ''
          merged=$(echo "$userJson" | ${jq} \
            --slurpfile base "${piConfig}/settings.json" \
            '. * $base[0]')
        ''
      }
        echo "$merged" > "$settingsFile.tmp"
        mv "$settingsFile.tmp" "$settingsFile"
        chmod u+w "$settingsFile"
      fi
    '');
  };
}
