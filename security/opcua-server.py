"""OPC UA server offering two doors: NoSecurity and Sign&Encrypt (Basic256Sha256).
The capstone of the man-on-the-wire series: the one protocol that can defend itself,
if you make it. Own equipment / isolated lab only."""
import asyncio, datetime, ipaddress
from asyncua import Server, ua
from cryptography import x509
from cryptography.x509.oid import NameOID
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa

APP_URI = "urn:pumpserver"
CERT, KEY = "/cert.pem", "/key.pem"


def make_cert():
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "pumpserver")])
    cert = (
        x509.CertificateBuilder()
        .subject_name(name).issuer_name(name).public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(datetime.datetime(2026, 1, 1))
        .not_valid_after(datetime.datetime(2030, 1, 1))
        .add_extension(x509.SubjectAlternativeName([
            x509.UniformResourceIdentifier(APP_URI),
            x509.IPAddress(ipaddress.ip_address("0.0.0.0")),
        ]), critical=False)
        .add_extension(x509.KeyUsage(digital_signature=True, key_encipherment=True,
            data_encipherment=True, content_commitment=True, key_agreement=False,
            key_cert_sign=False, crl_sign=False, encipher_only=False, decipher_only=False),
            critical=False)
        .sign(key, hashes.SHA256())
    )
    open(CERT, "wb").write(cert.public_bytes(serialization.Encoding.PEM))
    open(KEY, "wb").write(key.private_bytes(serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))


async def main():
    make_cert()
    server = Server()
    await server.init()
    server.set_endpoint("opc.tcp://0.0.0.0:4840/pump/")
    server.set_server_name("Pump OPC UA Server")
    await server.set_application_uri(APP_URI)
    server.set_security_policy([
        ua.SecurityPolicyType.NoSecurity,
        ua.SecurityPolicyType.Basic256Sha256_SignAndEncrypt,
    ])
    await server.load_certificate(CERT)
    await server.load_private_key(KEY)

    idx = await server.register_namespace("http://pump.lab")
    obj = await server.nodes.objects.add_object(idx, "Pump")
    speed = await obj.add_variable(idx, "Speed", 42.0)
    await speed.set_writable()

    async with server:
        print("OPC UA server up on :4840 — NoSecurity + Sign&Encrypt, Pump.Speed=42.0", flush=True)
        while True:
            await asyncio.sleep(2)


asyncio.run(main())
