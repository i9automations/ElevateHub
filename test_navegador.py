"""Testes do navegador.py (app Python .exe). Roda com:  python -m unittest test_navegador
Foca na extracao do codigo de verificacao (parte sensivel: nao pode pegar numero
errado, e o match do alias precisa ser exato — testado via emails)."""
import unittest
import navegador as nav


class ExtrairCodigo(unittest.TestCase):
    def test_codigo_perto_de_palavra_chave(self):
        casos = [
            ("Seu codigo de verificacao TikTok e 123456", "123456"),
            ("Your verification code is 654321", "654321"),
            ("Codigo: 4021", "4021"),
            ("O codigo e 246810 use agora", "246810"),
        ]
        for texto, esperado in casos:
            self.assertEqual(nav._extrair_codigo_tiktok(texto), esperado, texto)

    def test_ignora_numero_de_pedido_e_rastreio(self):
        # sem palavra-chave por perto e com contexto "ruim" -> nao pega
        self.assertIsNone(
            nav._extrair_codigo_tiktok("Seu pedido 987654 foi enviado. Rastreio 111222"))

    def test_ignora_ano(self):
        self.assertIsNone(nav._extrair_codigo_tiktok("Copyright 2026 TikTok"))
        self.assertIsNone(nav._extrair_codigo_tiktok("codigo 2025"))  # ano, nao codigo

    def test_texto_vazio(self):
        self.assertIsNone(nav._extrair_codigo_tiktok(""))
        self.assertIsNone(nav._extrair_codigo_tiktok(None))


class Slug(unittest.TestCase):
    def test_slug_remove_invalidos(self):
        # tira so os caracteres invalidos de nome de arquivo; mantem espacos
        self.assertEqual(nav._slug('Loja: A/B*?'), "Loja AB")
        self.assertEqual(nav._slug('a\\b|c<d>'), "abcd")
        self.assertEqual(nav._slug(""), "conta")


if __name__ == "__main__":
    unittest.main()
