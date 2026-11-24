const config = require('../src/config');
let adminTokenPromise = null;

const promoteToReseller = async (request, userId) => {
  if (!adminTokenPromise) {
    adminTokenPromise = request('/api/auth/login', {
      method: 'POST',
      body: { phone: config.ADMIN.phone, password: config.ADMIN.password }
    }).then((adminLogin) => {
      if (adminLogin.status !== 200) throw new Error(`Test admin login failed: ${adminLogin.status}`);
      return adminLogin.body.token;
    }).catch((error) => {
      adminTokenPromise = null;
      throw error;
    });
  }
  const adminToken = await adminTokenPromise;

  const response = await request(`/api/admin/users/${userId}/role`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: { role: 'reseller' }
  });
  if (response.status !== 200) {
    throw new Error(`Test reseller approval failed: ${response.status}`);
  }
  return response;
};

const registerReseller = async (request, user) => {
  const registration = await request('/api/auth/register', { method: 'POST', body: user });
  if (registration.status === 201) {
    await promoteToReseller(request, registration.body.user.id);
  }
  return registration;
};

module.exports = { promoteToReseller, registerReseller };
