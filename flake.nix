{
  description = "should build it??";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

  outputs = { nixpkgs, ... }:
    let
      systems = [
        "aarch64-darwin"
        "x86_64-darwin"
        "aarch64-linux"
        "x86_64-linux"
      ];
    in
    {
      devShells = nixpkgs.lib.genAttrs systems (system:
        let
          pkgs = import nixpkgs { inherit system; };
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
        in
        {
          default = pkgs.mkShell {
            packages = with pkgs; [
              nodejs_22
              gcc
              gnumake
              pkg-config
              python3
              git
              tree-sitter
              podman
              tex
              plantuml
              graphviz
              poppler-utils
            ];

            TREE_SITTER_C_SOURCE = pkgs.tree-sitter.grammars.tree-sitter-c.src;
            TREE_SITTER_C_LIBRARY = "${pkgs.tree-sitter-grammars.tree-sitter-c}/parser";
          };
        });
    };
}
