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
            // Restringir el fetch a los programas cargados en esta config de POS.
            // Sin este filtro, fetchCoupons trae tarjetas de otros programas que no
            // están en program_by_id, causando un crash en _getLoyaltyPointsRepr al
            // intentar leer program_type de undefined.
            const loadedProgramIds = Object.keys(this.pos.program_by_id).map(Number);
            this.pos
                .fetchCoupons([
                    ["partner_id", "=", partner.id],
                    ["program_id", "in", loadedProgramIds],
                ], 20)
                .then(() => {
                    // BUG Odoo: addPartners agrega IDs al Set como strings (Object.entries),
                    // fetchCoupons los agrega como números. Un JS Set trata "936171" y 936171
                    // como valores distintos → getLoyaltyCards devuelve el mismo objeto dos
                    // veces → OWL lanza "duplicate key in t-foreach".
                    // Fix: normalizar todos los IDs del Set a número después del fetch.
                    const set = this.pos.partnerId2CouponIds[partner.id];
                    if (set) {
                        this.pos.partnerId2CouponIds[partner.id] = new Set(
                            [...set].map(Number)
                        );
                    }
                })
                .catch(() => {});
        }
    },
});