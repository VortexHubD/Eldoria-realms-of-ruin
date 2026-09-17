#!/usr/bin/env python3
import os
import shutil
import subprocess
import sys
import webbrowser

ROOT = os.path.dirname(os.path.abspath(__file__))
os.chdir(ROOT)
PORT = os.environ.get("PORT", "8080")

def have(cmd):
    return shutil.which(cmd) is not None

print("==================================================")
print("  Eldoria: Realms of Ruin")
print("==================================================")

if have("node"):
    print(" Iniciando servidor multijugador (Node)...")
    print(f" Abre http://localhost:{PORT}")
    print(" Tus amigos en la misma red pueden entrar con tu IP.")
    print("==================================================")
    webbrowser.open(f"http://localhost:{PORT}")
    os.environ["PORT"] = str(PORT)
    os.execv(shutil.which("node"), [shutil.which("node"), os.path.join(ROOT, "server.js")])

print(" Node.js no está instalado. Servidor simple SIN multijugador de red.")
print(" Instala Node.js para jugar con amigos en la red.")
print(f" Abre http://localhost:{PORT}")
print("==================================================")
webbrowser.open(f"http://localhost:{PORT}")
raise SystemExit(os.system(f"{sys.executable} -m http.server {PORT}"))
