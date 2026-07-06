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
#   - symlinks the vendored settings.json + sandbox extension into ~/.config/pi
#   - installs extra packages (bubblewrap + socat on Linux, plus anything extra)
#
# pi's own packages (e.g. "npm:pi-rtk") and extension paths are declared in
# pi/settings.json in this repo — that file is the single source of truth for
# pi-level config and is symlinked verbatim. Edit it there, not here.
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
        "pi/settings.json".source = "${piConfig}/settings.json";
        "pi/extensions/sandbox".source = "${piConfig}/extensions/sandbox";
      }
      // lib.mapAttrs' (name: path: {
        name = "pi/extensions/${name}";
        value.source = path;
      })
      cfg.extensions;
  };
}
