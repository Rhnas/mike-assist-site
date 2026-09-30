#!/usr/bin/env python3
"""Gera o QR Code estático do Pix (BR Code) como SVG, sem depender de site externo.

Uso:
    python3 tools/gerar-qr-pix.py "<chave-pix>" [NOME] [CIDADE] [saida.svg]

Requer: opencv-python (cv2) e numpy.

Por que isto existe: o QR antigo do app codificava "pix:<chave>", que não é o
formato do Banco Central. O padrão é o "BR Code" (EMV), com campos TLV e CRC16.
O script monta o payload, gera o QR, e confere decodificando de volta.
"""
import sys
import cv2
import numpy as np


def tlv(tag: str, value: str) -> str:
    return f"{tag}{len(value):02d}{value}"


def crc16_ccitt(data: str) -> str:
    crc = 0xFFFF
    for byte in data.encode("ascii"):
        crc ^= byte << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xFFFF if crc & 0x8000 else (crc << 1) & 0xFFFF
    return f"{crc:04X}"


def br_code(chave: str, nome: str, cidade: str) -> str:
    conta = tlv("00", "br.gov.bcb.pix") + tlv("01", chave)
    corpo = (
        tlv("00", "01")          # versão do payload
        + tlv("01", "11")        # 11 = QR estático reutilizável
        + tlv("26", conta)       # dados da conta (chave Pix)
        + tlv("52", "0000")      # categoria
        + tlv("53", "986")       # moeda BRL
        + tlv("58", "BR")
        + tlv("59", nome[:25])
        + tlv("60", cidade[:15])
        + tlv("62", tlv("05", "***"))
    )
    corpo += "6304"
    return corpo + crc16_ccitt(corpo)


def matriz_qr(payload: str) -> np.ndarray:
    params = cv2.QRCodeEncoder_Params()
    params.correction_level = cv2.QRCodeEncoder_CORRECT_LEVEL_M
    img = cv2.QRCodeEncoder.create(params).encode(payload)
    escuro = img < 128
    ys, xs = np.where(escuro)
    recorte = escuro[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
    # Largura do módulo = comprimento da primeira sequência escura / 7 (finder pattern)
    linha = recorte[0]
    corrida = 0
    for v in linha:
        if v:
            corrida += 1
        else:
            break
    modulo = max(1, round(corrida / 7))
    n = recorte.shape[0] // modulo
    return recorte[::modulo, ::modulo][:n, :n]


def svg(matriz: np.ndarray, borda: int = 4) -> str:
    n = matriz.shape[0]
    total = n + 2 * borda
    partes = []
    for y in range(n):
        for x in range(n):
            if matriz[y, x]:
                partes.append(f"M{x + borda} {y + borda}h1v1h-1z")
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {total} {total}" '
        f'shape-rendering="crispEdges" role="img" aria-label="QR Code Pix">'
        f'<rect width="{total}" height="{total}" fill="#ffffff"/>'
        f'<path d="{"".join(partes)}" fill="#000000"/></svg>\n'
    )


def conferir(matriz: np.ndarray, payload: str) -> bool:
    n = matriz.shape[0]
    escala, borda = 12, 4
    img = np.full(((n + 2 * borda) * escala,) * 2, 255, dtype=np.uint8)
    for y in range(n):
        for x in range(n):
            if matriz[y, x]:
                y0, x0 = (y + borda) * escala, (x + borda) * escala
                img[y0:y0 + escala, x0:x0 + escala] = 0
    # O detector Aruco é mais robusto que o clássico com imagens sintéticas.
    detector = cv2.QRCodeDetectorAruco() if hasattr(cv2, "QRCodeDetectorAruco") else cv2.QRCodeDetector()
    nitida, _, _ = detector.detectAndDecode(img)
    # Também confere com leve desfoque, que simula a leitura pela câmera.
    borrada, _, _ = detector.detectAndDecode(cv2.GaussianBlur(img, (0, 0), escala / 6))
    return nitida == payload and borrada == payload


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    chave = sys.argv[1]
    nome = (sys.argv[2] if len(sys.argv) > 2 else "MIKE ASSIST").upper()
    cidade = (sys.argv[3] if len(sys.argv) > 3 else "RIO DE JANEIRO").upper()
    saida = sys.argv[4] if len(sys.argv) > 4 else "qr-pix.svg"

    assert crc16_ccitt("123456789") == "29B1", "CRC16 fora do padrão"
    payload = br_code(chave, nome, cidade)
    m = matriz_qr(payload)
    ok = conferir(m, payload)
    if not ok:
        sys.exit("ERRO: o QR gerado não decodificou de volta ao mesmo payload.")
    open(saida, "w", encoding="utf-8").write(svg(m))
    print(f"OK: {saida} ({m.shape[0]}x{m.shape[0]} módulos). Payload com {len(payload)} caracteres.")
