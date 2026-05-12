/** @odoo-module **/
import { Order } from "@point_of_sale/app/store/models";
import { patch } from "@web/core/utils/patch";

// Mantiene el cache de cupones actualizado con los saldos reales del backend.
//
// El problema: fetchLoyaltyCard devuelve la entrada cacheada sin consultar la DB
// una vez que las tarjetas del cliente están en couponCache. Si otro terminal o
// una orden anterior modificó el saldo, el POS muestra datos desactualizados.
//
// La solución anterior borraba el cache ANTES de llamar super.set_partner, lo que
// forzaba un fetch de la DB dentro del mutex de _updateRewards. Esto bloqueaba el
// flujo de pago si el cajero pagaba antes de que el fetch terminara.
//
// Esta versión hace el refresh de forma segura:
// 1. Llama super.set_partner normalmente (usa el cache viejo, no bloquea el mutex).
// 2. DESPUÉS del super, lanza fetchCoupons fuera del mutex → actualiza el cache.
// 3. Llama _updateRewards de nuevo para que recompute con los saldos frescos.
// El pago nunca espera este ciclo porque no tiene lugar dentro del mutex.
patch(Order.prototype, {
    set_partner(partner) {
        const oldPartner = this.get_partner();
        super.set_partner(partner);
        if (partner && partner !== oldPartner && partner.id) {
            // fetchCoupons es un ORM call directo, no usa el mutex de _updateRewards.
            // Cuando resuelve actualiza couponCache con los saldos reales del backend.
            // No hace falta llamar _updateRewards de nuevo: getLoyaltyPoints() lee
            // couponCache[id].balance en cada render, así que el próximo ciclo de
            // OWL ya muestra el saldo actualizado sin ningún ciclo extra de rewards.
            this.pos
                .fetchCoupons([["partner_id", "=", partner.id]], 20)
                .catch(() => {});
        }
    },
});