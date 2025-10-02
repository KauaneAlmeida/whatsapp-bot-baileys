import logging
import os
import re
import uuid
from datetime import datetime, timedelta
from typing import Dict, Any, Optional
from fastapi import APIRouter, Request
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, Field

from app.services.orchestration_service import intelligent_orchestrator
from app.services.baileys_service import send_baileys_message, get_baileys_status
from app.services.firebase_service import save_user_session, get_user_session

logger = logging.getLogger(__name__)
router = APIRouter()

VERIFY_TOKEN = os.getenv("WHATSAPP_VERIFY_TOKEN", "s3nh@-webhook-2025-XYz")

# =================== MODELOS ===================

class WhatsAppAuthorizationRequest(BaseModel):
    session_id: str = Field(..., description="Unique session ID for WhatsApp")
    phone_number: str = Field(..., description="WhatsApp phone number")
    source: str = Field(default="landing_page", description="Authorization source")
    user_data: Optional[Dict[str, Any]] = Field(default=None, description="User data")
    timestamp: str = Field(default_factory=lambda: datetime.utcnow().isoformat())

class WhatsAppAuthorizationResponse(BaseModel):
    status: str
    session_id: str
    phone_number: str
    source: str
    message: str
    timestamp: str
    expires_in: Optional[int] = Field(default=3600)
    whatsapp_url: str

# =================== VALIDAÇÃO ===================

def validate_phone_number(phone: str) -> str:
    phone_clean = re.sub(r'[^\d]', '', phone)
    
    if len(phone_clean) == 11:
        phone_clean = f"55{phone_clean}"
    elif len(phone_clean) == 13 and phone_clean.startswith("55"):
        pass
    else:
        raise ValueError(f"Invalid phone number format: {phone}")
    
    if not phone_clean.startswith("55"):
        raise ValueError("Phone number must be Brazilian (+55)")
    
    area_code = phone_clean[2:4]
    number = phone_clean[4:]
    
    if not (11 <= int(area_code) <= 99):
        raise ValueError(f"Invalid Brazilian area code: {area_code}")
    
    if not (8 <= len(number) <= 9):
        raise ValueError(f"Invalid phone number length: {len(number)} digits")
    
    return phone_clean

def validate_session_id(session_id: str) -> str:
    if len(session_id) < 10:
        raise ValueError("Session ID too short")
    
    if len(session_id) == 36:
        uuid.UUID(session_id)
    
    if re.search(r'[<>"\'\\\n\r\t]', session_id):
        raise ValueError("Invalid characters in session ID")
    
    return session_id.strip()

# =================== AUTORIZAÇÃO ===================

def extract_session_from_message(message: str) -> Optional[str]:
    if not message:
        return None
        
    patterns = [
        r'whatsapp_\w+_\w+',
        r'session_[\w-]+',
        r'web_\d+',
        r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}',
        r'\[Ficha:[^\]]+\]'
    ]
    
    for pattern in patterns:
        match = re.search(pattern, message, re.IGNORECASE)
        if match:
            session_id = match.group(0)
            logger.info(f"🔍 Session ID extraído: {session_id}")
            return session_id
            
    return None

async def is_session_authorized(session_id: str) -> Dict[str, Any]:
    try:
        if not session_id:
            return {"authorized": False, "action": "IGNORE_COMPLETELY", "reason": "no_session_id"}
            
        auth_data = await get_user_session(f"whatsapp_auth_session:{session_id}")
        
        if not auth_data:
            return {"authorized": False, "action": "IGNORE_COMPLETELY", "reason": "session_not_authorized"}
        
        expires_at_str = auth_data.get("expires_at", "")
        if expires_at_str:
            try:
                expires_at = datetime.fromisoformat(expires_at_str.replace('Z', '+00:00'))
                is_expired = datetime.now(expires_at.tzinfo) > expires_at
                
                if is_expired:
                    return {"authorized": False, "action": "IGNORE_COMPLETELY", "reason": "session_expired"}
            except Exception as date_error:
                logger.warning(f"⚠️ Erro ao verificar expiração: {str(date_error)}")
        
        return {
            "authorized": True,
            "action": "RESPOND",
            "session_id": session_id,
            "source": auth_data.get("source"),
            "user_data": auth_data.get("user_data", {}),
            "authorized_at": auth_data.get("authorized_at"),
            "lead_type": auth_data.get("lead_type", "continuous_chat")
        }
        
    except Exception as e:
        logger.error(f"❌ Erro ao verificar autorização: {str(e)}")
        return {"authorized": False, "action": "IGNORE_COMPLETELY", "reason": "error", "error": str(e)}

async def save_session_authorization(session_id: str, phone_number: str, source="landing_page", user_data=None):
    try:
        auth_data = {
            "authorized_at": datetime.utcnow().isoformat(),
            "expires_at": (datetime.utcnow() + timedelta(hours=1)).isoformat(),
            "phone_number": phone_number,
            "source": source,
            "user_data": user_data or {},
            "lead_type": "landing_whatsapp",
            "first_interaction": True
        }
        await save_user_session(f"whatsapp_auth_session:{session_id}", auth_data)
        await save_user_session(f"whatsapp_phone:{phone_number}", {"session_id": session_id})
        logger.info(f"✅ Autorização salva: {session_id} -> {phone_number}")
        return auth_data
    except Exception as e:
        logger.error(f"❌ Erro ao salvar autorização: {str(e)}")
        raise

# =================== ENDPOINT AUTHORIZE ===================

@router.post("/whatsapp/authorize", response_model=WhatsAppAuthorizationResponse)
async def authorize_whatsapp(request: WhatsAppAuthorizationRequest):
    try:
        session_id = validate_session_id(request.session_id)
        phone_number = validate_phone_number(request.phone_number)

        await save_session_authorization(
            session_id=session_id,
            phone_number=phone_number,
            source=request.source,
            user_data=request.user_data
        )

        return WhatsAppAuthorizationResponse(
            status="authorized",
            session_id=session_id,
            phone_number=phone_number,
            source=request.source,
            message="Sessão autorizada com sucesso",
            timestamp=datetime.utcnow().isoformat(),
            expires_in=3600,
            whatsapp_url=f"https://wa.me/{phone_number}"
        )
    except Exception as e:
        logger.error(f"❌ Erro na autorização WhatsApp: {str(e)}")
        return WhatsAppAuthorizationResponse(
            status="error",
            session_id=request.session_id,
            phone_number=request.phone_number,
            source=request.source,
            message=f"Erro ao autorizar: {str(e)}",
            timestamp=datetime.utcnow().isoformat(),
            expires_in=0,
            whatsapp_url=""
        )

# =================== WEBHOOK ===================

@router.get("/whatsapp/webhook")
async def verify_whatsapp_webhook(request: Request):
    params = request.query_params
    mode = params.get("hub.mode")
    token = params.get("hub.verify_token")
    challenge = params.get("hub.challenge")

    if mode == "subscribe" and token == VERIFY_TOKEN:
        logger.info("✅ WhatsApp webhook verified")
        return PlainTextResponse(challenge or "")
    
    logger.warning("⚠️ WhatsApp webhook verification failed")
    return PlainTextResponse("Forbidden", status_code=403)

@router.post("/whatsapp/webhook")
async def whatsapp_webhook(request: Request):
    try:
        payload = await request.json()
        logger.info(f"📨 WhatsApp webhook: {payload}")

        message_text = payload.get("message", "").strip()
        phone_number = payload.get("from") or payload.get("phone_number", "")
        message_id = payload.get("messageId") or payload.get("message_id", "")
        
        clean_phone = phone_number.replace('@s.whatsapp.net', '').replace('@g.us', '')
        
        if not message_text or not phone_number or not message_id:
            logger.warning("⚠️ Invalid webhook payload")
            return {"status": "error", "message": "Invalid payload", "response": "Erro: mensagem inválida"}

        logger.info(f"🔍 Verificando autorização | phone={clean_phone}")

        session_id = extract_session_from_message(message_text)
        
        if not session_id:
            # tenta recuperar pelo número
            phone_session = await get_user_session(f"whatsapp_phone:{clean_phone}")
            if phone_session and "session_id" in phone_session:
                session_id = phone_session["session_id"]
                logger.info(f"🔄 Sessão recuperada pelo número: {session_id}")
            else:
                logger.info(f"❌ Nenhum session_id encontrado | Respondendo fallback | phone={clean_phone}")
                return {
                    "status": "fallback",
                    "phone_number": clean_phone,
                    "message_id": message_id,
                    "action": "ASK_FOR_FICHA",
                    "reason": "no_session_id_in_message",
                    "response": "Olá! Para continuar o atendimento, precisamos identificar sua ficha.\n\n ⚠️ Clique no botão da nossa landing page para gerar sua ficha e voltar aqui."
                }
        
        # 🔑 Garante que a sessão está registrada/autorizada no Firebase
        auth_check = await is_session_authorized(session_id)
        if not auth_check["authorized"]:
            logger.info(f"⚠️ Session não encontrada, criando autorização temporária | session={session_id}")
            auth_check = await save_session_authorization(session_id, clean_phone)

            # 👉 Envia saudação inicial na primeira vez
            greeting = "Olá, Bem-vindo ao escritório m.lima!⚖️ Vou te ajudar com algumas perguntas rápidas para entendermos melhor seu caso."
            await send_baileys_message(clean_phone, greeting)
            logger.info(f"✅ Saudação inicial enviada para {clean_phone}")

        logger.info(f"✅ DELEGANDO para orchestrator | session={session_id} | source={auth_check.get('source')}")

        # 🔥 PROCESSA MENSAGEM COM ORCHESTRATOR
        orchestrator_response = await intelligent_orchestrator.process_message(
            message=message_text,
            session_id=session_id,
            phone_number=clean_phone,
            platform="whatsapp"
        )
        
        ai_response = orchestrator_response.get("response", "")
        response_type = orchestrator_response.get("response_type", "orchestrated")
        
        # ⚡ AJUSTE: Bloqueia pergunta desnecessária de número
        if "telefone" in ai_response.lower() or "whatsapp" in ai_response.lower():
            logger.info("⚠️ Orchestrator pediu número, ignorando pois já temos do WhatsApp")
            ai_response = "Obrigado pelos detalhes! 📝\n\nVocê já reuniu documentos/provas sobre essa situação ou ainda não?"
        
        if not ai_response or not isinstance(ai_response, str) or ai_response.strip() == "":
            ai_response = "Obrigado pela sua mensagem! Nossa equipe entrará em contato em breve."
            logger.warning(f"⚠️ Response vazio, usando fallback")
        
        # 🔥 ENVIA RESPOSTA (SEM SEND_PRESENCE - REMOVIDO)
        await send_baileys_message(clean_phone, ai_response)
        
        logger.info(f"✅ Response enviado: '{ai_response[:50]}...'")
        
        return {
            "status": "success",
            "message_id": message_id,
            "session_id": session_id,
            "phone_number": clean_phone,
            "source": auth_check.get("source", "landing_page"),
            "lead_type": auth_check.get("lead_type", "continuous_chat"),
            "authorized": True,
            "response": ai_response,
            "response_type": response_type,
            "current_step": orchestrator_response.get("current_step", ""),
            "message_count": orchestrator_response.get("message_count", 1)
        }

    except Exception as e:
        logger.error(f"❌ WhatsApp webhook error: {str(e)}")
        
        return {
            "status": "error",
            "message": str(e),
            "response_type": "error_message",
            "response": "Desculpe, ocorreu um erro temporário. Tente novamente em alguns minutos.",
            "phone_number": clean_phone if 'clean_phone' in locals() else "",
            "message_id": message_id if 'message_id' in locals() else ""
        }