"""OPC UA client — read Pump.Speed twice: once through the NoSecurity door (cleartext
on the wire) and once through Sign&Encrypt (opaque on the wire). The capstone contrast.
Own equipment / isolated lab only."""
import asyncio, datetime, ipaddress
from asyncua import Client
from cryptography import x509
from cryptography.x509.oid import NameOID
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa

URL = "opc.tcp://opcua-plc:4840/pump/"
CURI = "urn:pumpclient"
CCERT, CKEY, SCERT = "/ccert.pem", "/ckey.pem", "/server.pem"


def make_cert():
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    n = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "pumpclient")])
    c = (x509.CertificateBuilder().subject_name(n).issuer_name(n)
         .public_key(key.public_key()).serial_number(x509.random_serial_number())
         .not_valid_before(datetime.datetime(2026, 1, 1))
         .not_valid_after(datetime.datetime(2030, 1, 1))
         .add_extension(x509.SubjectAlternativeName([x509.UniformResourceIdentifier(CURI)]), critical=False)
         .add_extension(x509.KeyUsage(digital_signature=True, key_encipherment=True,
             data_encipherment=True, content_commitment=True, key_agreement=False,
             key_cert_sign=False, crl_sign=False, encipher_only=False, decipher_only=False), critical=False)
         .sign(key, hashes.SHA256()))
    open(CCERT, "wb").write(c.public_bytes(serialization.Encoding.PEM))
    open(CKEY, "wb").write(key.private_bytes(serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))


async def read(node_desc, client):
    idx = await client.get_namespace_index("http://pump.lab")
    node = await client.nodes.objects.get_child([f"{idx}:Pump", f"{idx}:Speed"])
    return await node.read_value()


async def main():
    make_cert()

    # Door 1: NoSecurity — the value crosses the wire in the clear.
    async with Client(URL) as c:
        v = await read("none", c)
        print(f"NoSecurity     read Pump.Speed = {v}   (cleartext on the wire)")

    await asyncio.sleep(1)

    # Door 2: Sign & Encrypt — the same read, unreadable to the wire.
    c2 = Client(URL)
    await c2.set_security_string(f"Basic256Sha256,SignAndEncrypt,{CCERT},{CKEY},{SCERT}")
    await c2.connect()
    try:
        v = await read("enc", c2)
        print(f"Sign&Encrypt   read Pump.Speed = {v}   (encrypted on the wire)")
    finally:
        await c2.disconnect()


asyncio.run(main())
