# Home-manager module for pi-agent.
#
#   imports = [ pi-agent.homeManagerModules.default ];
#   programs.pi-agent.enable = true;
#
# This installs pi and srt, sets PI_CODING_AGENT_DIR and PI_SANDBOX_SRT_BIN,
# symlinks the sandbox and agent-notify extensions and APPEND_SYSTEM.md under
# configDir, and merges pi/settings.json into settings.json on activation.
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
      lib.mkEnableOption "pi-agent (the pi coding agent with the sandbox and agent-notify extensions)"
      // {default = false;};

    package = lib.mkOption {
      type = lib.types.nullOr lib.types.package;
      default = llmPkgs.pi or null;
      description = ''
        The pi package to install. Defaults to the package from llm-agents.nix.
        Set to null to skip it if pi is installed some other way.
      '';
    };

    srtPackage = lib.mkOption {
      type = lib.types.nullOr lib.types.package;
      default = llmPkgs.sandbox-runtime or null;
      description = ''
        The srt (sandbox-runtime) package. Defaults to the package from
        llm-agents.nix. Set to null to skip it. Commands that need the OS
        sandbox are then blocked instead of running unsandboxed.
      '';
    };

    extraPackages = lib.mkOption {
      type = lib.types.listOf lib.types.package;
      default = [];
      description = ''
        Extra packages to install with pi and srt. On Linux, bubblewrap and
        socat are added automatically when srt is enabled.
      '';
    };

    extensions = lib.mkOption {
      type = lib.types.attrsOf (lib.types.either lib.types.path lib.types.str);
      default = {};
      description = ''
        Extra pi extensions to symlink into configDir/extensions. The attribute
        name is the directory name and the value is the store path holding the
        extension's .ts files. The sandbox and agent-notify extensions come
        from this flake, so this is only for other extensions.
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
        Extra settings to merge into configDir/settings.json along with the
        curated pi/settings.json. These keys win on activation; keys not set
        here, such as a model chosen in the UI, are kept. `packages` is unioned
        with the on-disk value so locally installed packages survive a switch,
        and a package removed from the curated list is dropped using the state
        file .pi-curated-packages.json.
      '';
      example = {
        defaultProvider = "anthropic";
        defaultModel = "claude-sonnet-4-6";
      };
    };

    configDir = lib.mkOption {
      type = lib.types.str;
      default = "${config.xdg.configHome}/pi";
      description = ''
        Where pi keeps its config. Also sets PI_CODING_AGENT_DIR and where the
        curated settings and extension symlinks are written. Must be inside the
        home directory because Home Manager can only manage files there.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    # Home Manager can only manage files inside the home directory.
    assertions = [
      {
        assertion = lib.hasPrefix "${config.home.homeDirectory}/" cfg.configDir;
        message = "programs.pi-agent.configDir must be inside ${config.home.homeDirectory}";
      }
    ];

    home = {
      packages =
        lib.optional (cfg.package != null) cfg.package
        ++ lib.optional (cfg.srtPackage != null) cfg.srtPackage
        ++ cfg.extraPackages
        # srt needs bubblewrap and socat on Linux. ripgrep comes from dev-tools.
        ++ lib.optional (pkgs.stdenv.isLinux && cfg.srtPackage != null) pkgs.bubblewrap
        ++ lib.optional (pkgs.stdenv.isLinux && cfg.srtPackage != null) pkgs.socat;

      sessionVariables = lib.mkMerge [
        {PI_CODING_AGENT_DIR = cfg.configDir;}
        (lib.mkIf (cfg.srtPackage != null) {
          PI_SANDBOX_SRT_BIN = "${cfg.srtPackage}/bin/srt";
        })
      ];

      # Symlink the curated config tree under configDir so changing
      # PI_CODING_AGENT_DIR also moves the extensions.
      file =
        {
          "${cfg.configDir}/APPEND_SYSTEM.md".source = "${piConfig}/APPEND_SYSTEM.md";
          "${cfg.configDir}/extensions/sandbox".source = "${piConfig}/extensions/sandbox";
          "${cfg.configDir}/extensions/agent-notify".source = "${piConfig}/extensions/agent-notify";
        }
        // lib.mapAttrs' (name: path: {
          name = "${cfg.configDir}/extensions/${name}";
          value.source = path;
        })
        cfg.extensions;

      # settings.json is mutable because pi writes runtime state. A store
      # symlink would fail with EPERM.
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
  };
}
