{
  description = "Lexeme: C11 code explorer (Electron + React, Fastify backend, Tree-sitter analyzer) and its report";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

  outputs = { nixpkgs, ... }:
    let
      systems = [
        "aarch64-darwin"
        "x86_64-darwin"
        "aarch64-linux"
        "x86_64-linux"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      devShells = forAllSystems (pkgs:
        let
          inherit (pkgs.stdenv) isLinux;

          # App: Node runs the backend's .ts directly (type stripping needs >= 22.18).
          # The analyzer's Tree-sitter grammar comes from npm as WebAssembly, so no
          # native tree-sitter is needed. A C compiler expands macros (LEXEME_CC).
          app = with pkgs; [
            nodejs_22
            git
            cmake # scripts/fetch-codebases.sh generates compile_commands.json
            gnumake
          ]
          ++ (if isLinux then [
            gcc
            podman # container mode; macOS uses a Podman machine installed outside Nix
            electron # npm's prebuilt Electron does not run on NixOS
          ] else [
            stdenv.cc # Apple SDK-aware clang wrapper
          ]);

          appEnv = {
            # Analyzer compiler: real GCC on Linux, the clang wrapper (`cc`) on macOS.
            LEXEME_CC = if isLinux then "gcc" else "cc";
          } // pkgs.lib.optionalAttrs isLinux {
            ELECTRON_SKIP_BINARY_DOWNLOAD = "1";
            ELECTRON_OVERRIDE_DIST_PATH = "${pkgs.electron}/bin";
          };

          # Report (../main.tex) and its diagrams.
          tex = pkgs.texlive.combine {
            inherit (pkgs.texlive)
              scheme-small
              latexmk
              booktabs
              cite
              xurl
              sttools
              pgf
              cm-super
              ;
          };
          report = with pkgs; [ tex plantuml graphviz poppler-utils ];
        in
        {
          # Everything: app + report toolchain.
          default = pkgs.mkShell ({ packages = app ++ report; } // appEnv);
          # App only (no TeX): `nix develop .#app`
          app = pkgs.mkShell ({ packages = app; } // appEnv);
        });
    };
}
