"""
Gera o `creators-panel.exe` — o painel "Adicionar creators" (motor Afiliador)
que o ElevateHub empacota e dispara. NAO baixa navegador: usa o Chrome que o
ElevateHub ja embute (o painel recebe o caminho via config).

Pre-requisitos (uma vez):
    pip install pyinstaller playwright pandas openpyxl
    (NAO precisa de `playwright install` — usamos o Chrome do ElevateHub.)

Uso (nesta pasta):
    python build_sidecar.py
-> gera v2/afiliador/dist/creators-panel.exe

O electron-builder do desktop copia esse .exe pra resources/creators/ (ver
extraResources no package.json do desktop).
"""
import os
import PyInstaller.__main__ as M

HERE = os.path.dirname(os.path.abspath(__file__))
SEP = ";" if os.name == "nt" else ":"

M.run([
    "--onefile",
    "--name", "creators-panel",
    "--noconfirm",
    "--distpath", os.path.join(HERE, "dist"),
    "--workpath", os.path.join(HERE, "build_tmp"),
    "--specpath", os.path.join(HERE, "build_tmp"),
    # asset lido em tempo de execucao (logo do painel)
    f"--add-data={os.path.join(HERE, 'logo_tiktok.b64')}{SEP}.",
    # Playwright precisa do seu driver junto (node + pacote)
    "--collect-all", "playwright",
    # leitura de planilha
    "--collect-all", "openpyxl",
    "--hidden-import", "pandas",
    # painel_web importa add_creators -> o PyInstaller segue o import sozinho
    os.path.join(HERE, "painel_web.py"),
])
