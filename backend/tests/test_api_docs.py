from .conftest import client_for


def test_openapi_schema_and_swagger_page_for_back_office(owner, accountant):
    schema = client_for(owner).get("/api/v1/schema/", HTTP_ACCEPT="application/json")
    assert schema.status_code == 200, schema.content[:300]
    paths = schema.json()["paths"]
    for path in ("/api/v1/sales/", "/api/v1/day/start/", "/api/v1/shifts/{id}/close/", "/api/v1/products/", "/api/v1/stock/opening/"):
        assert path in paths, path
    page = client_for(accountant).get("/api/v1/docs/", HTTP_ACCEPT="text/html")
    assert page.status_code == 200 and b"swagger" in page.content.lower()


def test_health_check_is_public_and_reveals_nothing():
    response = client_for().get("/api/v1/health/")
    assert response.status_code == 200 and response.json() == {"status": "ok"}
